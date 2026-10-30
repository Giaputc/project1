# main.py
import os

import numpy as np


os.environ["GRPC_VERBOSITY"] = "ERROR"
os.environ["GRPC_CPP_LOG_LEVEL"] = "ERROR"

from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi import Security
import fitz  # PyMuPDF
bearer_scheme = HTTPBearer()


import time
import hashlib
import base64
import traceback
from datetime import datetime, timedelta
from io import BytesIO
from PIL import Image
from typing import List, Dict, Any

import PyPDF2
from pdfminer.high_level import extract_text as extract_pdfminer_text

# optional OCR & PDF->image libs (only used if available)
try:
    from pdf2image import convert_from_path
    import pytesseract
    OCR_AVAILABLE = True
except Exception:
    convert_from_path = None
    pytesseract = None
    OCR_AVAILABLE = False

from fastapi import FastAPI, UploadFile, File, Depends, HTTPException, Header, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from sqlalchemy import create_engine, Column, Integer, String, Text, DateTime, ForeignKey, text
from sqlalchemy.orm import sessionmaker, declarative_base, Session
from passlib.context import CryptContext
from jose import jwt, JWTError
from pydantic import BaseModel
from dotenv import load_dotenv

import google.generativeai as genai   # Gemini API

# ================== In-memory cache ==================
PDF_CACHE: Dict[int, str] = {}

# FAISS_INDEXES: { pdf_id: { "index": faiss_index, "metadatas": [ {type:'text'|'image', 'chunk':..., 'page':...}, ... ] } }
FAISS_INDEXES: Dict[int, Dict[str, Any]] = {}

# Thêm cache embedding toàn cục cho mỗi PDF (1 vector/file)
PDF_GLOBAL_EMBEDS: Dict[int, np.ndarray] = {}


# ================== Embedding imports (try Vintern then fallback) ==================
EMBED_MODEL_NAME = os.getenv("EMBED_MODEL", "5CD-AI/Vintern-Embedding-1B")
EMBED_PROVIDER = None  # "vintern" | "sbert" | None

try:
    # try transformers + vintern style processor/model
    import torch
    from transformers import AutoProcessor, AutoModel
    PROCESSOR = AutoProcessor.from_pretrained(EMBED_MODEL_NAME, trust_remote_code=True)
    VINTERN_MODEL = AutoModel.from_pretrained(
        EMBED_MODEL_NAME,
        torch_dtype=torch.bfloat16 if torch.cuda.is_available() else None,
        low_cpu_mem_usage=True,
        trust_remote_code=True,
    )
    VINTERN_MODEL.eval()
    if torch.cuda.is_available():
        VINTERN_MODEL = VINTERN_MODEL.to("cuda")
    EMBED_PROVIDER = "vintern"
except Exception:
    PROCESSOR = None
    VINTERN_MODEL = None
    # fallback to sentence-transformers if available
    try:
        from sentence_transformers import SentenceTransformer
        EMBED_SBRET = SentenceTransformer('all-MiniLM-L6-v2')
        EMBED_PROVIDER = "sbert"
    except Exception:
        EMBED_PROVIDER = None

# FAISS optional
try:
    import faiss
    FAISS_AVAILABLE = True
except Exception:
    faiss = None
    FAISS_AVAILABLE = False

import numpy as np

# ================== Load ENV ==================
load_dotenv()

ADMIN_TOKEN = os.getenv("ADMIN_TOKEN", "super_secret_admin")
SECRET_KEY = os.getenv("SECRET_KEY", "my_jwt_secret_key")
STORAGE_DIR = os.getenv("STORAGE_DIR", "./storage/pdfs")
IMAGES_TMP_DIR = os.path.join(STORAGE_DIR, ".img_cache")
# By default we DO NOT rasterize whole pages — prefer embedded images only.
PAGE_IMAGE_FALLBACK = os.getenv("PAGE_IMAGE_FALLBACK", "false").lower() in ("1", "true", "yes")
SIMILAR_PDF_THRESHOLD = float(os.getenv("SIMILAR_PDF_THRESHOLD", "0.8"))
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")

if not GEMINI_API_KEY:
    raise RuntimeError("⚠️ Missing GEMINI_API_KEY in .env")
genai.configure(api_key=GEMINI_API_KEY)

os.makedirs(STORAGE_DIR, exist_ok=True)
os.makedirs(IMAGES_TMP_DIR, exist_ok=True)

# ================== Database ==================
DATABASE_URL = "sqlite:///./pdfqa.db"
engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
Base = declarative_base()

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, unique=True)
    hashed_password = Column(String)
    is_admin = Column(Integer, default=0)

class PDF(Base):
    __tablename__ = "pdfs"
    id = Column(Integer, primary_key=True, index=True)
    filename = Column(String, unique=True)
    global_embedding = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

class SearchHistory(Base):
    __tablename__ = "search_history"
    id = Column(Integer, primary_key=True, autoincrement=True)
    pdf_id = Column(Integer, ForeignKey("pdfs.id"))
    user_id = Column(Integer, ForeignKey("users.id"))
    question = Column(Text, nullable=False)
    answer = Column(Text, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

Base.metadata.create_all(bind=engine)

# --- Safe startup migration: ensure `created_at` exists on `pdfs` table ---
def _ensure_created_at_column():
    try:
        with engine.connect() as conn:
            cols = [r[1] for r in conn.execute(text("PRAGMA table_info('pdfs')")).fetchall()]
            if 'created_at' not in cols:
                print("🔧 Migration: adding 'created_at' column to 'pdfs' table")
                # Add the column (SQLite supports ADD COLUMN)
                conn.execute(text("ALTER TABLE pdfs ADD COLUMN created_at DATETIME"))
                # populate existing rows: prefer file mtime, otherwise use now
                sess = SessionLocal()
                try:
                    from datetime import datetime
                    for pdf in sess.query(PDF).all():
                        if not getattr(pdf, 'created_at', None):
                            try:
                                path = os.path.join(STORAGE_DIR, pdf.filename)
                                if os.path.exists(path):
                                    mtime = os.path.getmtime(path)
                                    pdf.created_at = datetime.utcfromtimestamp(mtime)
                                else:
                                    pdf.created_at = datetime.utcnow()
                                sess.add(pdf)
                            except Exception:
                                pdf.created_at = datetime.utcnow()
                                sess.add(pdf)
                    sess.commit()
                    print("✅ Migration: populated 'created_at' for existing rows")
                finally:
                    sess.close()
    except Exception as e:
        print(f"⚠️ Migration error ensuring created_at column: {e}")


# Run the migration on startup (idempotent)
_ensure_created_at_column()

# ================== App ==================
app = FastAPI(title="PDF QA System with Gemini (text+image embeddings)")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:5175"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# ================== In-memory cache ==================
PDF_CACHE: Dict[int, str] = {}

# FAISS_INDEXES: { pdf_id: { "index": faiss_index, "metadatas": [ {type:'text'|'image', 'chunk':..., 'page':...}, ... ] } }
FAISS_INDEXES: Dict[int, Dict[str, Any]] = {}

# ================== Utility Functions ==================
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

def verify_password(plain, hashed):
    return pwd_context.verify(plain, hashed)

def get_password_hash(password):
    return pwd_context.hash(password)

def create_access_token(data: dict, expires_delta: timedelta = None):
    to_encode = data.copy()
    expire = datetime.utcnow() + (expires_delta if expires_delta else timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES))
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)

def get_current_user(
    credentials: HTTPAuthorizationCredentials = Security(bearer_scheme),
    db: Session = Depends(get_db)
):
    token = credentials.credentials
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        username: str = payload.get("sub")
        if not username:
            raise HTTPException(status_code=401, detail="Invalid token")
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid token")
    user = db.query(User).filter(User.username == username).first()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user


def extract_pdf_text(file_path: str) -> str:
    """
    1) Try pdfminer (better for text-based PDFs)
    2) Fallback PyPDF2
    3) If still empty and OCR available, do OCR (for scanned PDFs)
    """
    text = ""
    try:
        text = extract_pdfminer_text(file_path) or ""
        if text and len(text.strip()) > 20:
            return text.strip()
    except Exception:
        pass

    try:
        with open(file_path, "rb") as f:
            reader = PyPDF2.PdfReader(f)
            pages_text = []
            for page in reader.pages:
                pages_text.append(page.extract_text() or "")
            text = "\n".join(pages_text).strip()
            if text and len(text) > 20:
                return text
    except Exception:
        pass

    # OCR fallback if installed
    if OCR_AVAILABLE and convert_from_path is not None:
        try:
            images = convert_from_path(file_path, dpi=200)
            ocr_texts = []
            for img in images:
                ocr_texts.append(pytesseract.image_to_string(img, lang="vie+eng"))
            text = "\n".join(ocr_texts).strip()
            return text
        except Exception:
            pass

    return text.strip()

def chunk_text(text: str, chunk_size: int = 350) -> List[str]:
    words = text.split()
    if not words:
        return []
    return [" ".join(words[i:i + chunk_size]) for i in range(0, len(words), chunk_size)]

def select_model(text_length: int):
    if text_length > 10000:
        return "models/gemini-2.5-pro"
    elif text_length > 3000:
        return "models/gemini-2.5-flash"
    else:
        return "models/gemini-2.5-flash-lite"

def make_cache_key(pdf_id: int, question: str):
    return hashlib.sha256(f"{pdf_id}:{question}".encode()).hexdigest()

# ----------------- Helpers for PDF->page image and base64 -----------------
import os
from pdf2image import convert_from_path

def render_pdf_page_to_pil(file_path: str, page_number: int):
    """
    Render a single page (1-based page_number) to PIL Image using pdf2image.
    Returns PIL.Image or None.
    """
    POPPLER_PATH = os.getenv(
        "POPPLER_PATH",
        r"C:\Users\DELL\Downloads\Release-25.07.0-0\poppler-25.07.0\Library\bin"
    )

    # ✅ Chuyển file_path thành đường dẫn tuyệt đối
    abs_path = os.path.abspath(file_path)
    print(f"🧩 DEBUG | Render page {page_number}")
    print(f"   → File path: {abs_path}")
    print(f"   → Poppler path: {POPPLER_PATH}")
    print(f"   → File exists? {os.path.exists(abs_path)}")

    abs_path = os.path.abspath(file_path)
    if not os.path.exists(abs_path):
        return None

    try:
        imgs = convert_from_path(
            abs_path,
            dpi=150,
            first_page=page_number,
            last_page=page_number,
            poppler_path=POPPLER_PATH
        )
        if not imgs:
            return None

        img = imgs[0].copy()  # copy image để giữ ngoài scope
        # đóng tất cả ảnh gốc
        for i in imgs:
            i.close()
        return img
    except Exception as e:
        print(f"Lỗi render trang {page_number}: {e}")
        return None


def extract_images_from_pdf_page(file_path: str, page_number: int) -> List[Any]:
    """Extract embedded images from a PDF page using PyMuPDF (fitz).

    Returns a list of PIL.Image objects (may be empty if no embedded images found).
    This prefers embedded images over rasterizing the whole page.
    """
    try:
        if not os.path.exists(file_path):
            return []
        doc = fitz.open(file_path)
        # pages in fitz are 0-indexed
        pnum = page_number - 1
        if pnum < 0 or pnum >= doc.page_count:
            doc.close()
            return []

        page = doc.load_page(pnum)
        images_info = page.get_images(full=True)
        imgs: List[Any] = []
        for img_index, img_meta in enumerate(images_info):
            xref = img_meta[0]
            try:
                pix = fitz.Pixmap(doc, xref)
                # convert CMYK or other formats to RGB for Pillow
                if pix.n > 4:  # CMYK: convert
                    pix = fitz.Pixmap(fitz.csRGB, pix)

                img_bytes = pix.tobytes("png")
                pil = Image.open(BytesIO(img_bytes)).convert("RGB")
                imgs.append(pil)
            except Exception as e:
                print(f"⚠️ Could not extract xref={xref} on page={page_number}: {e}")
            finally:
                try:
                    pix = None
                except Exception:
                    pass

        doc.close()
        return imgs
    except Exception as e:
        print(f"⚠️ extract_images_from_pdf_page failed for {file_path} page {page_number}: {e}")
        return []



def pil_image_to_base64_dataurl(img) -> str:
    buffered = BytesIO()
    with img:
        img.save(buffered, format="PNG")
    encoded = base64.b64encode(buffered.getvalue()).decode("utf-8")
    return f"data:image/png;base64,{encoded}"


def find_pages_with_text(file_path: str, question: str) -> List[int]:
    """Find pages that appear to contain the question text or some tokens.

    Simple heuristic: check if the whole question (lower) is substring of page text
    or any token (length>3) from the question appears in the page text.
    Returns 1-based page numbers.
    """
    pages_found: List[int] = []
    try:
        if not os.path.exists(file_path):
            return pages_found
        # keep the file handle open while we iterate around pages (PyPDF2 may read lazily)
        with open(file_path, "rb") as fh:
            reader = PyPDF2.PdfReader(fh)
            q_low = question.lower().strip()
            tokens = [t for t in q_low.split() if len(t) > 3]
            for i, page in enumerate(reader.pages, start=1):
                try:
                    ptext = (page.extract_text() or "").lower()
                    if not ptext:
                        continue
                    if q_low and q_low in ptext:
                        pages_found.append(i)
                        continue
                    # token match heuristic
                    for t in tokens:
                        if t in ptext:
                            pages_found.append(i)
                            break
                except Exception:
                    continue
    except Exception as e:
        print(f"⚠️ find_pages_with_text failed for {file_path}: {e}")
    return pages_found


# ================== Embedding builder/search ==================
def encode_texts_with_provider(texts: List[str]) -> np.ndarray:
    """
    Returns numpy array (n, dim) float32 embeddings for texts using chosen provider.
    """
    if EMBED_PROVIDER == "vintern":
        # use PROCESSOR + VINTERN_MODEL
        all_embs = []
        batch_size = 8
        for i in range(0, len(texts), batch_size):
            batch = texts[i:i+batch_size]
            batch_docs = PROCESSOR.process_docs(batch)
            # move tensors to device if model on cuda
            inputs = {}
            for k, v in batch_docs.items():
                if torch.is_tensor(v):
                    if VINTERN_MODEL.device.type == "cuda":
                        inputs[k] = v.to("cuda")
                    else:
                        inputs[k] = v
                else:
                    inputs[k] = v
            with torch.no_grad():
                out = VINTERN_MODEL(**inputs)
                # many trust_remote_code models return embedding-like outputs; attempt to handle common shapes
                # try attribute 'last_hidden_state' or return object itself
                if hasattr(out, "pooler_output") and out.pooler_output is not None:
                    emb = out.pooler_output.cpu().numpy()
                elif hasattr(out, "last_hidden_state"):
                    # mean pool
                    emb = out.last_hidden_state.mean(dim=1).cpu().numpy()
                else:
                    # if model returns tensor directly
                    try:
                        emb = out.cpu().numpy()
                        if emb.ndim == 2:
                            pass
                        else:
                            emb = emb.reshape(len(batch), -1)
                    except Exception:
                        raise RuntimeError("Unexpected Vintern model output format")
                all_embs.append(emb.astype("float32"))
        return np.vstack(all_embs)
    elif EMBED_PROVIDER == "sbert":
        embs = EMBED_SBRET.encode(texts, convert_to_numpy=True, show_progress_bar=False)
        if embs.dtype != "float32":
            embs = embs.astype("float32")
        return embs
    else:
        raise RuntimeError("No embedding provider available. Install Vintern or sentence-transformers.")

def encode_images_with_provider(images: List[Any]) -> np.ndarray:
    """
    images: list of PIL.Image
    returns numpy array (n, dim) float32
    """
    if EMBED_PROVIDER == "vintern":
        all_embs = []
        batch_size = 4
        for i in range(0, len(images), batch_size):
            batch = images[i:i+batch_size]
            batch_inputs = PROCESSOR.process_images(batch)
            # move tensors to device
            inputs = {}
            for k, v in batch_inputs.items():
                if torch.is_tensor(v):
                    if VINTERN_MODEL.device.type == "cuda":
                        inputs[k] = v.to("cuda").bfloat16()
                    else:
                        inputs[k] = v
                else:
                    inputs[k] = v
            with torch.no_grad():
                out = VINTERN_MODEL(**inputs)
                if hasattr(out, "pooler_output") and out.pooler_output is not None:
                    emb = out.pooler_output.cpu().numpy()
                elif hasattr(out, "last_hidden_state"):
                    emb = out.last_hidden_state.mean(dim=1).cpu().numpy()
                else:
                    try:
                        emb = out.cpu().numpy()
                    except Exception:
                        raise RuntimeError("Unexpected Vintern model output for images")
                all_embs.append(emb.astype("float32"))
        return np.vstack(all_embs)
    elif EMBED_PROVIDER == "sbert":
        # SBERT not for images; return zeros or raise
        raise RuntimeError("Image embeddings require Vintern (transformers).")
    else:
        raise RuntimeError("No embedding provider available.")

# ================== XÂY DỰNG CHỈ MỤC VECTOR CHO TEXT + IMAGE ==================
import fitz  # PyMuPDF
def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """
    a, b: 1D np.array
    """
    if a.ndim > 1:
        a = a.reshape(-1)
    if b.ndim > 1:
        b = b.reshape(-1)
    na = np.linalg.norm(a) + 1e-8
    nb = np.linalg.norm(b) + 1e-8
    return float(np.dot(a, b) / (na * nb))


def encode_pdf_global_embedding(text: str) -> np.ndarray:
    """
    Encode toàn bộ nội dung PDF thành 1 vector (global embedding).
    Có thể:
      - encode trực tiếp full text
      - hoặc chia chunk rồi lấy trung bình
    Ở đây: chia chunk và lấy trung bình để ổn định hơn.
    """
    if not text:
        raise RuntimeError("PDF text is empty, cannot build global embedding")

    chunks = chunk_text(text, 350)
    # giới hạn số chunk để không quá nặng
    chunks = chunks[:20]
    embs = encode_texts_with_provider(chunks)  # shape (n, dim)
    global_emb = embs.mean(axis=0).astype("float32")
    return global_emb

def build_pdf_embedding(pdf_id: int, pdf_text: str, file_path: str):
    if not FAISS_AVAILABLE or not EMBED_PROVIDER:
        return

    import numpy as np
    import torch
    from transformers import CLIPProcessor, CLIPModel
    import faiss
    import PyPDF2

    # load CLIP model một lần
    clip_model = CLIPModel.from_pretrained("openai/clip-vit-base-patch32")
    clip_processor = CLIPProcessor.from_pretrained("openai/clip-vit-base-patch32")

    vectors = []
    metadatas = []

    # mở file PDF và đọc tất cả pages
    try:
        with open(file_path, "rb") as f:
            reader = PyPDF2.PdfReader(f)
            for i, page in enumerate(reader.pages, start=1):
                page_text = page.extract_text() or ""

                # 1️⃣ Text embedding
                if page_text.strip():
                    chunks = chunk_text(page_text, 350)
                    try:
                        text_embs = encode_texts_with_provider(chunks).astype("float32")
                        vectors.append(text_embs)
                        for chunk in chunks:
                            metadatas.append({"type": "text", "page": i, "chunk": chunk})
                    except Exception as e:
                        print(f"⚠️ Lỗi embedding text page {i}: {e}")

                # 2️⃣ Image embedding
                try:
                    page_imgs = extract_images_from_pdf_page(file_path, i)
                    if page_imgs:
                        # If our embedding provider can do image embeddings (Vintern) we will use it.
                        # If the provider is sentence-transformers (SBERT) we skip mixing image embeddings
                        # with text embeddings (dims will not match). In that case we only keep image
                        # data for later extraction (not for FAISS index) to avoid dimension mismatch.
                        if EMBED_PROVIDER == "vintern":
                            try:
                                img_embs = encode_images_with_provider(page_imgs).astype("float32")
                                vectors.append(img_embs)
                                for img_idx in range(img_embs.shape[0]):
                                    metadatas.append({"type": "image", "page": i, "chunk": None, "img_index": img_idx})
                            except Exception:
                                # fallback per-image with CLIP (may also be same dim as Vintern, but handle carefully)
                                for idx, pil_img in enumerate(page_imgs):
                                    try:
                                        inputs = clip_processor(images=pil_img, return_tensors="pt")
                                        with torch.no_grad():
                                            clip_emb = clip_model.get_image_features(**inputs)
                                        img_emb = clip_emb.cpu().numpy().astype("float32")
                                        vectors.append(img_emb)
                                        metadatas.append({"type": "image", "page": i, "chunk": None, "img_index": idx})
                                    except Exception as e:
                                        print(f"⚠️ Fallback CLIP failed for page image {i}, idx={idx}: {e}")
                        else:
                            # EMBED_PROVIDER is not Vintern (example: sbert). We skip adding image
                            # vectors to the FAISS index because SBERT text vectors (e.g. 384-d)
                            # will not match CLIP image vectors (e.g. 512-d) and would cause vstack errors.
                            print(f"ℹ️ Skipping image embeddings for page {i} (provider={EMBED_PROVIDER}) to avoid mixed-dimension FAISS index")

                except Exception as e:
                    print(f"⚠️ Lỗi extract images page {i}: {e}")
                finally:
                    # ensure we always close PIL images objects when created
                    try:
                        if 'page_imgs' in locals() and page_imgs:
                            for pil_img in page_imgs:
                                try:
                                    pil_img.close()
                                except Exception:
                                    pass
                    except Exception:
                        pass

    except Exception as e:
        raise RuntimeError(f"⚠️ Không thể mở hoặc đọc PDF {file_path}: {e}")

    if not vectors:
        raise RuntimeError(f"Không có vector nào để tạo index cho PDF id={pdf_id}")

    # --- Tạo FAISS index ---
    try:
        # Flatten into individual rows so we can reason about per-row dims and metadata
        flat_rows = []
        for block in vectors:
            # block is a (n, dim) array
            for row in block:
                flat_rows.append(row)

        # quick check: must be same dimension across rows for FAISS. If not, try to
        # handle it safely:
        row_dims = [r.size for r in flat_rows]
        unique_dims = sorted(set(row_dims))
        if len(unique_dims) > 1:
            print(f"⚠️ Mixed embedding dimensions detected for pdf_id={pdf_id}: {unique_dims}")
            if EMBED_PROVIDER == "vintern":
                # safest approach: pad smaller vectors to the maximum dimension so we can vstack.
                target_dim = max(unique_dims)
                padded_rows = []
                for r in flat_rows:
                    if r.size < target_dim:
                        pad = np.zeros((target_dim - r.size,), dtype=np.float32)
                        padded_rows.append(np.concatenate([r, pad]))
                    elif r.size > target_dim:
                        padded_rows.append(r[:target_dim].astype("float32"))
                    else:
                        padded_rows.append(r.astype("float32"))
                all_vectors = np.vstack(padded_rows).astype("float32")
                # metadatas remain aligned
            else:
                # For providers that can't embed both text+image consistently (eg. SBERT + CLIP fallback),
                # choose the most common embedding dimension (likely the text dim) and only keep rows with that dim.
                from collections import Counter
                dim_counts = Counter(row_dims)
                target_dim = dim_counts.most_common(1)[0][0]
                kept_rows = []
                kept_meta = []
                meta_iter = iter(metadatas)
                for r in flat_rows:
                    m = next(meta_iter)
                    if r.size == target_dim:
                        kept_rows.append(r.astype("float32"))
                        kept_meta.append(m)
                if not kept_rows:
                    raise RuntimeError(f"No consistent-dimension vectors available for PDF id={pdf_id} to build FAISS index")
                all_vectors = np.vstack(kept_rows).astype("float32")
                metadatas = kept_meta
        else:
            all_vectors = np.vstack(flat_rows).astype("float32")

        dim = all_vectors.shape[1]
        index = faiss.IndexFlatL2(dim)
        index.add(all_vectors)
        FAISS_INDEXES[pdf_id] = {"index": index, "metadatas": metadatas}
        print(f"✅ FAISS index tạo xong cho pdf_id={pdf_id}, tổng {index.ntotal} vectors")
    except Exception as e:
        raise RuntimeError(f"⚠️ Lỗi tạo FAISS index cho PDF id={pdf_id}: {e}")


# ================== Schemas ==================
class LoginRequest(BaseModel):
    username: str
    password: str

class AskRequest(BaseModel):
    question: str

# ================== Auth ==================
@app.post("/auth/login")
def login(req: LoginRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.username == req.username).first()
    if not user or not verify_password(req.password, user.hashed_password):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    token = create_access_token({"sub": user.username})
    return {"access_token": token, "token_type": "bearer"}

# ================== PDF Management ==================
@app.get("/pdf/")
def list_pdfs(db: Session = Depends(get_db)):
    pdfs = db.query(PDF).order_by(PDF.created_at.desc()).all()
    return [
        {"id": p.id, "filename": p.filename, "created_at": p.created_at.isoformat() if p.created_at else None}
        for p in pdfs
    ]

@app.get("/pdf/{filename}")
def get_pdf(filename: str):
    path = os.path.join(STORAGE_DIR, filename)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(path)

@app.post("/upload-pdf")
def upload_pdf(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user)
):
    file_path = os.path.join(STORAGE_DIR, file.filename)
    with open(file_path, "wb") as f:
        for chunk in iter(lambda: file.file.read(1024 * 1024), b""):
            f.write(chunk)

    # Tạo record PDF trước
    pdf = PDF(filename=file.filename, created_at=datetime.utcnow())
    db.add(pdf)
    db.commit()
    db.refresh(pdf)

    similar_info = None  # để trả về thông tin file nào giống nhất

    try:
        text = extract_pdf_text(file_path)
        PDF_CACHE[pdf.id] = text
        print(f"Cached uploaded PDF id={pdf.id} file={file.filename} chars={len(text)}")

        # 1️⃣ Build global embedding cho PDF mới (nếu có embedding provider)
        if EMBED_PROVIDER is not None and text:
            try:
                new_global_emb = encode_pdf_global_embedding(text)
                PDF_GLOBAL_EMBEDS[pdf.id] = new_global_emb

                # Lưu vào DB (serialize)
                pdf.global_embedding = base64.b64encode(new_global_emb.tobytes()).decode("utf-8")
                db.add(pdf)
                db.commit()

                # 2️⃣ So sánh với các PDF cũ
                max_sim = -1.0
                most_similar_pdf = None

                for old_pdf_id, old_emb in PDF_GLOBAL_EMBEDS.items():
                    if old_pdf_id == pdf.id:
                        continue  # bỏ qua chính nó
                    try:
                        sim = cosine_similarity(new_global_emb, old_emb)
                        if sim > max_sim:
                            max_sim = sim
                            most_similar_pdf = old_pdf_id
                    except Exception as e:
                        print(f"Error computing similarity with pdf_id={old_pdf_id}: {e}")

                # 3️⃣ Nếu tìm được file giống nhất và sim đủ cao (0.8-0.9 tuỳ bạn)
                SIM_THRESHOLD = SIMILAR_PDF_THRESHOLD
                if most_similar_pdf is not None and max_sim >= SIM_THRESHOLD:
                    old_pdf = db.query(PDF).filter(PDF.id == most_similar_pdf).first()
                    if old_pdf:
                        similar_info = {
                            "similar_to_id": old_pdf.id,
                            "similar_to_filename": old_pdf.filename,
                            "similarity": round(max_sim, 4),
                            "note": "File mới rất giống file cũ (>= 85%), có thể là bản cập nhật."
                        }
                        print(
                            f"📌 New PDF '{pdf.filename}' is similar to '{old_pdf.filename}' "
                            f"with similarity={max_sim:.4f}"
                        )

            except Exception as e:
                print(f"Error building global embedding for uploaded PDF {file.filename}: {e}")

        # 4️⃣ Build FAISS index text+image cho Q&A như cũ
        if EMBED_PROVIDER is not None and FAISS_AVAILABLE:
            try:
                build_pdf_embedding(pdf.id, text, file_path)
            except Exception as e:
                print(f"Error building embedding for uploaded PDF {file.filename}: {e}")

    except Exception as e:
        print(f"Error caching uploaded PDF {file.filename}: {e}")

    # Response thêm thông tin similar_info
    return {
        "id": pdf.id,
        "filename": pdf.filename,
        "created_at": pdf.created_at.isoformat() if pdf.created_at else None,
        "similar_info": similar_info
    }

@app.get("/pdf/download/{pdf_id}")
def download_pdf(pdf_id: int, db: Session = Depends(get_db)):
    pdf = db.query(PDF).filter(PDF.id == pdf_id).first()
    if not pdf:
        raise HTTPException(404, "PDF not found")
    file_path = os.path.join(STORAGE_DIR, pdf.filename)
    if not os.path.exists(file_path):
        raise HTTPException(404, "File missing")
    return FileResponse(file_path, filename=pdf.filename, media_type="application/pdf")

# ================== Admin ==================
@app.get("/admin/list")
def admin_list(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Not authorized")
    pdfs = db.query(PDF).order_by(PDF.created_at.desc()).all()
    return [
        {"id": p.id, "filename": p.filename, "created_at": p.created_at.isoformat() if p.created_at else None}
        for p in pdfs
    ]

@app.get("/admin/history")
def admin_history(limit: int = 20, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Not authorized")
    history = db.query(SearchHistory).order_by(SearchHistory.id.desc()).limit(limit).all()
    return [
        {
            "id": h.id,
            "pdf_id": h.pdf_id,
            "user_id": h.user_id,
            "question": h.question,
            "answer": h.answer,
            "created_at": h.created_at,
        }
        for h in history
    ]


@app.delete("/admin/history/{history_id}")
def admin_delete_history_item(history_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """Delete a single SearchHistory entry by id (admin only)."""
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Not authorized")
    entry = db.query(SearchHistory).filter(SearchHistory.id == history_id).first()
    if not entry:
        raise HTTPException(status_code=404, detail="History item not found")
    db.delete(entry)
    db.commit()
    return {"message": "History item deleted", "id": history_id}


@app.delete("/admin/history")
def admin_clear_history(all: bool = Query(False, description="If true, clear all history"), pdf_id: int = Query(None), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """Delete multiple history entries.

    - If all=true, delete all history records.
    - Else if pdf_id is provided, delete history for that pdf only.
    - Otherwise returns 400.
    """
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Not authorized")

    if all:
        deleted = db.query(SearchHistory).delete()
        db.commit()
        return {"message": "All history cleared", "deleted": deleted}

    if pdf_id is not None:
        deleted = db.query(SearchHistory).filter(SearchHistory.pdf_id == pdf_id).delete()
        db.commit()
        return {"message": "History cleared for PDF", "pdf_id": pdf_id, "deleted": deleted}

    raise HTTPException(status_code=400, detail="Specify `all=true` to clear all or provide `pdf_id` to clear for a specific PDF")

@app.delete("/admin/delete/{pdf_id}")
def delete_pdf(pdf_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Not authorized")
    pdf = db.query(PDF).filter(PDF.id == pdf_id).first()
    if not pdf:
        raise HTTPException(status_code=404, detail="PDF not found")
    file_path = os.path.join(STORAGE_DIR, pdf.filename)

    # Clear in-memory references first (this helps if our own process holds resources)
    if pdf_id in PDF_CACHE:
        PDF_CACHE.pop(pdf_id, None)
    if pdf_id in FAISS_INDEXES:
        FAISS_INDEXES.pop(pdf_id, None)
    if pdf_id in PDF_GLOBAL_EMBEDS:
        PDF_GLOBAL_EMBEDS.pop(pdf_id, None)

    # Try to delete the backing file. On Windows a PermissionError means some process
    # still holds the file (Explorer preview, other apps, or an open handle in this process).
    cleared = False
    try:
        if os.path.exists(file_path):
            os.remove(file_path)
        cleared = True
    except PermissionError as e:
        # attempt a gentle retry after garbage collection — sometimes closing references helps
        try:
            import gc, time
            gc.collect()
            time.sleep(0.35)
            if os.path.exists(file_path):
                os.remove(file_path)
            cleared = True
        except PermissionError:
            print(f"⚠️ PermissionError deleting file {file_path}: {e}")
            raise HTTPException(status_code=500, detail=(
                "Không thể xóa file — tệp đang được một tiến trình khác sử dụng. "
                "Hãy đóng chương trình đang dùng file (ví dụ: trình xem PDF / Explorer Preview) hoặc khởi động lại backend, rồi thử lại."))
        except Exception as e2:
            print(f"⚠️ Error deleting file on retry: {e2}")
            raise HTTPException(status_code=500, detail=f"Lỗi khi xóa file: {e2}")
    except Exception as e:
        print(f"⚠️ Error deleting file {file_path}: {e}")
        raise HTTPException(status_code=500, detail=f"Lỗi khi xóa file: {e}")

    # If we cleared the file (or it didn't exist), remove DB record
    if cleared:
        db.delete(pdf)
        db.commit()
    return {"message": "PDF deleted successfully"}

# ================== PDF QA with Gemini (now returns related images) ==================
# --- Giữ nguyên toàn bộ code trên của bạn ---
# (từ đầu file cho đến trước đoạn @app.post("/pdf/ask/{pdf_id}"))
# ================================================================

# ================== API: HỎI ĐÁP PDF (TEXT + ẢNH LIÊN QUAN) ==================
@app.post("/pdf/ask/{pdf_id}")
def ask_pdf(
    pdf_id: int,
    req: AskRequest,
    model: str = Query("auto", description="Gemini model: auto/pro/flash/lite"),
    allow_page_raster: bool = Query(False, description="Allow rasterizing whole pages as fallback when no embedded images found"),
    db: Session = Depends(get_db)
):
    start_ts = time.perf_counter()

    # 1️⃣ Lấy PDF từ DB
    pdf = db.query(PDF).filter(PDF.id == pdf_id).first()
    if not pdf:
        raise HTTPException(status_code=404, detail="PDF không tồn tại")

    file_path = os.path.join(STORAGE_DIR, pdf.filename)
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="File PDF bị thiếu")

    # 2️⃣ Đọc hoặc lấy text cache
    pdf_text = PDF_CACHE.get(pdf.id)
    if pdf_text is None:
        pdf_text = extract_pdf_text(file_path)
        PDF_CACHE[pdf.id] = pdf_text

    # 3️⃣ Xây lại FAISS nếu cần
    if EMBED_PROVIDER and FAISS_AVAILABLE and pdf_id not in FAISS_INDEXES:
        try:
            build_pdf_embedding(pdf.id, pdf_text, file_path)
        except Exception as e:
            print(f"⚠️ Không thể tạo FAISS index: {e}")

    selected_texts = []
    related_images = []

    # 4️⃣ Truy vấn vector (Tìm các đoạn hoặc trang liên quan)
    if pdf_id in FAISS_INDEXES and FAISS_AVAILABLE:
        try:
            idx_struct = FAISS_INDEXES[pdf_id]
            index = idx_struct["index"]
            metadatas = idx_struct["metadatas"]

            q_emb = encode_texts_with_provider([req.question]).astype("float32")
            k = min(6, index.ntotal)
            distances, indices = index.search(q_emb, k)

            hit_pages = set()
            for idx in indices[0]:
                meta = metadatas[int(idx)]
                if meta["type"] == "text" and meta["chunk"]:
                    selected_texts.append(meta["chunk"])
                if meta.get("page"):
                    hit_pages.add(meta["page"])

            # ✅ Chỉ render đúng các trang có hit
            for p in sorted(hit_pages):
                try:
                    # prefer embedded images
                    embedded_imgs = extract_images_from_pdf_page(file_path, p)
                    if embedded_imgs:
                        for idx, eimg in enumerate(embedded_imgs):
                            try:
                                related_images.append({
                                    "page": p,
                                    "img_index": idx,
                                    "base64": pil_image_to_base64_dataurl(eimg),
                                })
                            finally:
                                try:
                                    eimg.close()
                                except Exception:
                                    pass
                        print(f"✅ Extracted {len(embedded_imgs)} embedded images from page {p}")
                        continue

                    else:
                        # no embedded images found for this page — we skip rasterizing
                        # the full page and keep image-only behavior
                        print(f"ℹ️ No embedded images on page {p}, skipping page rasterization.")
                except Exception as img_err:
                    print(f"⚠️ Error processing images for page {p}: {img_err}")

        except Exception as e:
            print(f"⚠️ FAISS query lỗi: {e}")
            traceback.print_exc()
            selected_texts = chunk_text(pdf_text, 350)[:8] if pdf_text else []

    else:
        selected_texts = chunk_text(pdf_text, 350)[:8] if pdf_text else []

    # 5️⃣ Nếu không có ảnh tìm thấy từ FAISS hits, try to locate pages containing
    # the question text and extract embedded images from those pages.
    if not related_images:
        print("🔍 No related images from FAISS hits — searching PDF pages by text match")
        try:
            matched_pages = find_pages_with_text(file_path, req.question)
            if matched_pages:
                print(f"🔎 Found candidate pages by text match: {matched_pages}")
                # also include chunks from the PDF as additional context
                selected_texts = chunk_text(pdf_text, 350)[:8] if pdf_text else []
                for p in matched_pages:
                    try:
                        embedded = extract_images_from_pdf_page(file_path, p)
                        if embedded:
                            for idx, eimg in enumerate(embedded):
                                related_images.append({"page": p, "img_index": idx, "base64": pil_image_to_base64_dataurl(eimg)})
                                try:
                                    eimg.close()
                                except Exception:
                                    pass
                            print(f"✅ Extracted embedded images from page {p}")
                        else:
                            # If no embedded images and fallback allowed, render page
                            if PAGE_IMAGE_FALLBACK or allow_page_raster:
                                pil = render_pdf_page_to_pil(file_path, p)
                                if pil:
                                    related_images.append({"page": p, "base64": pil_image_to_base64_dataurl(pil)})
                                    print(f"✅ Rendered fallback page image for page {p}")
                    except Exception as e:
                        print(f"⚠️ Error extracting/rendering images for candidate page {p}: {e}")
            else:
                print("🔍 No page text matches found — falling back to first page (if allowed)")
                # keep old behaviour: check page 1 for embedded images, and optionally render it
                try:
                    embedded = extract_images_from_pdf_page(file_path, 1)
                    if embedded:
                        for idx, eimg in enumerate(embedded):
                            related_images.append({"page": 1, "img_index": idx, "base64": pil_image_to_base64_dataurl(eimg)})
                            try:
                                eimg.close()
                            except Exception:
                                pass
                        print("✅ Extracted embedded images from page 1")
                    else:
                        if PAGE_IMAGE_FALLBACK:
                            pil = render_pdf_page_to_pil(file_path, 1)
                            if pil:
                                related_images.append({"page": 1, "base64": pil_image_to_base64_dataurl(pil)})
                                print("✅ Rendered fallback page 1")
                        else:
                            print("ℹ️ No embedded images on page 1 and raster fallback disabled")
                except Exception as e:
                    print(f"⚠️ Error in fallback extract/render for page 1: {e}")
        except Exception as e:
            print(f"⚠️ Error searching pages for text matches: {e}")

    # 6️⃣ Tạo prompt cho Gemini
    context_text = "\n".join(selected_texts)[:8000] if selected_texts else ""
    if model == "auto":
        chosen_model = select_model(len(pdf_text) if pdf_text else 0)
    elif model == "pro":
        chosen_model = "models/gemini-2.5-pro"
    elif model == "flash":
        chosen_model = "models/gemini-2.5-flash"
    elif model == "lite":
        chosen_model = "models/gemini-2.5-flash-lite"
    else:
        chosen_model = model

    if context_text:
        prompt = f"""
Bạn là trợ lý AI. Hãy đọc nội dung PDF sau và chỉ trả lời dựa vào đó.
Nếu không có thông tin, hãy nói: "Không có thông tin trong tài liệu."

Nội dung PDF:
\"\"\"{context_text}\"\"\"

Câu hỏi: {req.question}
"""
    else:
        prompt = f"""
PDF này không có text rõ ràng, nhưng có ảnh kèm theo. 
Hãy cố gắng trả lời câu hỏi dựa vào hình ảnh được cung cấp.

Câu hỏi: {req.question}
"""

    # 7️⃣ Gọi Gemini
    try:
        gemini_model = genai.GenerativeModel(chosen_model)
        response = gemini_model.generate_content(prompt)
        answer = response.text.strip() if response and hasattr(response, "text") else "Không có phản hồi từ Gemini."
    except Exception as e:
        answer = f"Lỗi gọi Gemini API: {e}"

    # 8️⃣ Lưu lịch sử
    try:
        db.add(SearchHistory(pdf_id=pdf.id, user_id=0, question=req.question, answer=answer))
        db.commit()
    except Exception as e:
        print(f"⚠️ Không lưu được lịch sử: {e}")

    elapsed = time.perf_counter() - start_ts
    print(f"📤 Trả về {len(related_images)} ảnh")

    return {
        "pdf_id": pdf_id,
        "question": req.question,
        "answer": answer,
        "images": related_images,
        "model_used": chosen_model,
        "latency_s": round(elapsed, 2)
    }


@app.post("/pdf/ask_all")
def ask_all_pdfs(
        req: AskRequest,
        model: str = Query("auto", description="Gemini model: auto/pro/flash/lite"),
        db: Session = Depends(get_db)
):
    start_ts = time.perf_counter()

    # 🔥 SỬA: LẤY TẤT CẢ PDF, KHÔNG PHẢI PDF MỚI NHẤT
    pdfs = db.query(PDF).order_by(PDF.id.asc()).all()
    if not pdfs:
        raise HTTPException(status_code=404, detail="Không có PDF nào trong hệ thống")

    selected_texts = []
    related_images = []
    hit_pdfs = set()

    # 🔥 Lặp qua MỌI PDF
    for pdf in pdfs:
        file_path = os.path.join(STORAGE_DIR, pdf.filename)
        if not os.path.exists(file_path):
            continue

        pdf_text = PDF_CACHE.get(pdf.id)
        if pdf_text is None:
            pdf_text = extract_pdf_text(file_path)
            PDF_CACHE[pdf.id] = pdf_text

        # 🔥 build FAISS nếu chưa có
        if EMBED_PROVIDER and FAISS_AVAILABLE and pdf.id not in FAISS_INDEXES:
            try:
                build_pdf_embedding(pdf.id, pdf_text, file_path)
            except Exception as e:
                print(f"⚠️ Không thể tạo FAISS index cho {pdf.filename}: {e}")

        # 🔎 FAISS search nếu có index
        if pdf.id in FAISS_INDEXES and FAISS_AVAILABLE:
            try:
                idx_struct = FAISS_INDEXES[pdf.id]
                index = idx_struct["index"]
                metadatas = idx_struct["metadatas"]

                q_emb = encode_texts_with_provider([req.question]).astype("float32")
                k = min(5, index.ntotal)
                distances, indices = index.search(q_emb, k)

                hit_pages = set()

                for idx in indices[0]:
                    meta = metadatas[int(idx)]
                    if meta["type"] == "text" and meta["chunk"]:
                        selected_texts.append(meta["chunk"])
                    if meta.get("page"):
                        hit_pages.add(meta["page"])

                # nếu PDF này có trang liên quan
                if hit_pages:
                    hit_pdfs.add(pdf.id)

                    # 🔥 Lấy embedded images của PDF này
                    for p in sorted(hit_pages):
                        try:
                            embedded_imgs = extract_images_from_pdf_page(file_path, p)
                            if embedded_imgs:
                                for i, eimg in enumerate(embedded_imgs):
                                    related_images.append({
                                        "pdf": pdf.filename,
                                        "page": p,
                                        "img_index": i,
                                        "base64": pil_image_to_base64_dataurl(eimg)
                                    })
                                    try:
                                        eimg.close()
                                    except:
                                        pass
                                print(f"✅ Extracted {len(embedded_imgs)} embedded images from {pdf.filename} page {p}")
                            else:
                                print(f"ℹ️ No embedded images on page {p}, skipping.")
                        except Exception as e:
                            print(f"⚠️ Lỗi extract page {p}: {e}")

            except Exception as e:
                print(f"⚠️ FAISS query lỗi cho {pdf.filename}: {e}")
                traceback.print_exc()

        else:
            # ❗Fallback: lấy text nhiều hơn nhưng không lấy ảnh
            num_chunks = min(16, max(8, len(pdf_text) // 1000))
            selected_texts.extend(chunk_text(pdf_text, 350)[:num_chunks])
            print(f"ℹ️ Fallback: lấy {num_chunks} chunk text từ {pdf.filename}")

    # Combine tất cả text lại
    context_text = "\n".join(selected_texts)[:8000] if selected_texts else ""

    # ======================================
    # Chọn model
    if model == "auto":
        chosen_model = select_model(len(context_text))
    elif model == "pro":
        chosen_model = "models/gemini-2.5-pro"
    elif model == "flash":
        chosen_model = "models/gemini-2.5-flash"
    elif model == "lite":
        chosen_model = "models/gemini-2.5-flash-lite"
    else:
        chosen_model = model

    if context_text:
        prompt = f"""
Bạn là trợ lý AI. Hãy đọc kỹ tất cả tài liệu PDF sau và trả lời câu hỏi.

Nội dung PDF:
\"\"\"{context_text}\"\"\"

Câu hỏi: {req.question}
"""
    else:
        prompt = f"""
Không có văn bản nào phù hợp nhưng có một số ảnh.
Hãy trả lời dựa vào ảnh.

Câu hỏi: {req.question}
"""

    try:
        gemini_model = genai.GenerativeModel(chosen_model)
        response = gemini_model.generate_content(prompt)
        answer = response.text.strip()
    except Exception as e:
        answer = f"Lỗi Gemini API: {e}"

    # Lưu lịch sử (lấy PDF đầu tiên có hit, không thì PDF đầu tiên)
    try:
        first_pdf_id = list(hit_pdfs)[0] if hit_pdfs else pdfs[0].id
        db.add(SearchHistory(pdf_id=first_pdf_id, user_id=0, question=req.question, answer=answer))
        db.commit()
    except Exception as e:
        print(f"⚠️ Không lưu được lịch sử: {e}")

    elapsed = time.perf_counter() - start_ts

    return {
        "pdf_ids": list(hit_pdfs),
        "question": req.question,
        "answer": answer,
        "images": related_images,
        "model_used": chosen_model,
        "latency_s": round(elapsed, 2)
    }







# ================== Init Admin and Cache loading ==================
def create_admin():
    db = SessionLocal()
    if not db.query(User).filter(User.username == "admin").first():
        db.add(User(username="admin", hashed_password=get_password_hash("admin123"), is_admin=1))
        db.commit()
    db.close()

create_admin()

# load PDFs into cache at startup and build embeddings if available
with SessionLocal() as db:
    try:
        pdfs = db.query(PDF).all()
        for pdf in pdfs:
            try:
                path = os.path.join(STORAGE_DIR, pdf.filename)
                if os.path.exists(path):
                    # Load hoặc extract text
                    text = extract_pdf_text(path)
                    PDF_CACHE[pdf.id] = text

                    # Build FAISS index cho text+image
                    if EMBED_PROVIDER is not None and FAISS_AVAILABLE:
                        try:
                            build_pdf_embedding(pdf.id, text, path)
                        except Exception as e:
                            print(f"Failed building embedding for {pdf.filename}: {e}")

                    # Load hoặc tạo global embedding
                    if EMBED_PROVIDER is not None and text:
                        try:
                            if pdf.global_embedding:
                                arr = np.frombuffer(base64.b64decode(pdf.global_embedding), dtype="float32")
                                PDF_GLOBAL_EMBEDS[pdf.id] = arr
                            else:
                                global_emb = encode_pdf_global_embedding(text)
                                PDF_GLOBAL_EMBEDS[pdf.id] = global_emb
                                # lưu lại vào DB
                                pdf.global_embedding = base64.b64encode(global_emb.tobytes()).decode("utf-8")
                                db.add(pdf)
                                db.commit()
                        except Exception as e:
                            print(f"Error building/loading global embedding for {pdf.filename}: {e}")

            except Exception as e:
                print(f"Error caching {pdf.filename}: {e}")
    except Exception as e:
        print(f"Error loading PDF cache at startup: {e}")

