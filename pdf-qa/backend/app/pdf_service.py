import os
from PyPDF2 import PdfReader
from sentence_transformers import SentenceTransformer
from app.db_service import VectorDB
from app.llm_service import LLMService
from app.utils import ensure_dir, gen_id

CHUNK_SIZE = 800

class PDFService:
    def __init__(self, storage_dir: str = "storage"):
        ensure_dir(storage_dir)
        self.storage_dir = storage_dir
        self.pdf_dir = os.path.join(storage_dir, "pdfs")
        ensure_dir(self.pdf_dir)
        self.index_dir = os.path.join(storage_dir, "index")
        ensure_dir(self.index_dir)

        self.embed_model = SentenceTransformer("all-MiniLM-L6-v2")
        self.vectordb = VectorDB(self.index_dir)
        self.llm = LLMService()
        self.meta = {}

    def _extract_text(self, file_path: str) -> str:
        reader = PdfReader(file_path)
        pages = []
        for p in reader.pages:
            txt = p.extract_text()
            if txt:
                pages.append(txt)
        return "\n".join(pages)

    def _chunk_text(self, text: str):
        return [text[i:i+CHUNK_SIZE] for i in range(0, len(text), CHUNK_SIZE)]

    def process_pdf(self, content: bytes, filename: str) -> str:
        pdf_id = gen_id()
        out_path = os.path.join(self.pdf_dir, f"{pdf_id}.pdf")
        with open(out_path, "wb") as f:
            f.write(content)

        text = self._extract_text(out_path)
        chunks = self._chunk_text(text)
        if not chunks:
            raise RuntimeError("No extractable text from PDF")

        embeddings = self.embed_model.encode(chunks, convert_to_numpy=True)
        self.vectordb.add(embeddings, chunks)
        self.meta[pdf_id] = {"filename": filename, "path": out_path, "n_chunks": len(chunks)}
        return pdf_id

    def answer_question(self, question: str, use_openai: bool = False, top_k: int = 3) -> str:
        if not self.vectordb or not self.vectordb.chunks:
            return "No PDFs available. Upload at least one PDF first."
        q_emb = self.embed_model.encode([question], convert_to_numpy=True)
        results = self.vectordb.search(q_emb, top_k=top_k)
        context = "\n\n".join(results)

        if use_openai and self.llm.available():
            prompt = f"Use the following extracted text from PDFs as context to answer the question. If answer not present, say you cannot find it.\n\nContext:\n{context}\n\nQuestion: {question}\nAnswer:"
            try:
                return self.llm.ask(prompt)
            except Exception as e:
                return f"LLM call failed: {e}"
        else:
            return f"Related content:\n{context}"

    def list_pdfs(self):
        return self.meta

    def delete_pdf(self, pdf_id: str) -> bool:
        if pdf_id not in self.meta:
            return False
        path = self.meta[pdf_id]["path"]
        try:
            os.remove(path)
        except Exception:
            pass
        del self.meta[pdf_id]
        return True
