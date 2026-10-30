import os
import faiss
import numpy as np
import pickle

class VectorDB:
    def __init__(self, storage_dir: str):
        self.storage_dir = storage_dir
        os.makedirs(self.storage_dir, exist_ok=True)
        self.index = None
        self.metafile = os.path.join(self.storage_dir, "meta.pkl")
        self._load_meta()

    def _load_meta(self):
        if os.path.exists(self.metafile):
            with open(self.metafile, "rb") as f:
                data = pickle.load(f)
            self.index = data.get("index")
            self.chunks = data.get("chunks", [])
        else:
            self.index = None
            self.chunks = []

    def _save_meta(self):
        with open(self.metafile, "wb") as f:
            pickle.dump({"index": self.index, "chunks": self.chunks}, f)

    def build(self, embeddings: np.ndarray, chunks: list):
        dim = embeddings.shape[1]
        index = faiss.IndexFlatL2(dim)
        index.add(embeddings)
        self.index = index
        self.chunks = chunks
        self._save_meta()

    def add(self, embeddings: np.ndarray, chunks: list):
        if self.index is None:
            self.build(embeddings, chunks)
            return
        self.index.add(embeddings)
        self.chunks.extend(chunks)
        self._save_meta()

    def search(self, query_emb: np.ndarray, top_k: int = 3):
        if self.index is None:
            return []
        D, I = self.index.search(query_emb, top_k)
        results = []
        for idx in I[0]:
            if idx < len(self.chunks):
                results.append(self.chunks[idx])
        return results

    def clear(self):
        if os.path.exists(self.metafile):
            os.remove(self.metafile)
        self.index = None
        self.chunks = []
