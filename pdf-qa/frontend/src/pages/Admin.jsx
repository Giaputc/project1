import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import api, { setAuthToken, downloadFile } from "../api";

function Admin() {
  const [pdfs, setPdfs] = useState([]);
  const [file, setFile] = useState(null);
  const [history, setHistory] = useState([]);
  const [token, setToken] = useState(localStorage.getItem("token") || "");
  const navigate = useNavigate();

  useEffect(() => {
    if (!token) {
      navigate("/login");
    } else {
      setAuthToken(token);
      fetchPdfs();
      fetchHistory();
    }
  }, [token]);

  const fetchPdfs = async () => {
    try {
      const res = await api.get("/admin/list");
      setPdfs(res.data);
    } catch (err) {
      console.error("Lỗi khi load PDF:", err);
    }
  };

  const fetchHistory = async () => {
    try {
      const res = await api.get("/admin/history");
      setHistory(res.data);
    } catch (err) {
      console.error("Lỗi khi load lịch sử:", err);
    }
  };

  const handleDeleteHistoryItem = async (id) => {
    if (!confirm('Xác nhận xóa lịch sử này?')) return;
    try {
      await api.delete(`/admin/history/${id}`);
      alert('Xóa lịch sử thành công');
      fetchHistory();
    } catch (err) {
      console.error('Lỗi xóa lịch sử:', err);
    }
  };

  const handleClearAllHistory = async () => {
    if (!confirm('Xác nhận xóa toàn bộ lịch sử?')) return;
    try {
      await api.delete('/admin/history', { params: { all: true } });
      alert('Đã xóa toàn bộ lịch sử');
      fetchHistory();
    } catch (err) {
      console.error('Lỗi xóa toàn bộ lịch sử:', err);
    }
  };

  const handleUpload = async () => {
    if (!file) return;
    const formData = new FormData();
    formData.append("file", file);

    try {
      await api.post("/upload-pdf", formData, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      alert("Upload thành công!");
      fetchPdfs();
    } catch (err) {
      console.error("Lỗi upload:", err);
    }
  };

  const handleDelete = async (id) => {
    try {
      await api.delete(`/admin/delete/${id}`);
      alert("Xóa thành công!");
      fetchPdfs();
    } catch (err) {
      console.error("Lỗi xóa:", err);
    }
  };

  const downloadPdf = (filename) => downloadFile(filename);

  const handleLogout = () => {
    localStorage.removeItem("token");
    setAuthToken(null);
    navigate("/login");
  };

  return (
    <div className="min-h-screen bg-gray-100 p-6">
      {/* Header */}
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-3xl font-bold text-gray-700">📑 Trang Quản Trị</h1>
        <button
          onClick={handleLogout}
          className="bg-red-500 hover:bg-red-600 text-white px-4 py-2 rounded-lg shadow"
        >
          Đăng xuất
        </button>
      </div>

      {/* Upload */}
      <div className="bg-white p-6 rounded-lg shadow mb-6">
        <h2 className="text-lg font-semibold mb-4">📤 Upload PDF</h2>
        <div className="flex gap-3">
          <input
            type="file"
            onChange={(e) => setFile(e.target.files[0])}
            className="border rounded-lg p-2 flex-grow"
          />
          <button
            onClick={handleUpload}
            className="bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded-lg"
          >
            Upload
          </button>
        </div>
      </div>

      {/* Danh sách PDF */}
      <div className="bg-white p-6 rounded-lg shadow mb-6">
        <h2 className="text-lg font-semibold mb-4">📚 Danh sách PDF</h2>
        {pdfs.length === 0 ? (
          <p className="text-gray-500">Chưa có PDF nào.</p>
        ) : (
          <ul className="divide-y">
            {pdfs.map((pdf) => (
              <li key={pdf.id} className="flex justify-between items-center py-2">
                <span>{pdf.filename}</span>
                <div className="flex gap-2">
                  <button
                    onClick={() => downloadPdf(pdf.filename)}
                    className="bg-green-600 hover:bg-green-700 text-white px-3 py-1 rounded-lg text-sm"
                  >
                    Tải
                  </button>
                  <button
                    onClick={() => handleDelete(pdf.id)}
                    className="bg-red-500 hover:bg-red-600 text-white px-3 py-1 rounded-lg text-sm"
                  >
                    Xóa
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Lịch sử hỏi đáp */}
      <div className="bg-white p-6 rounded-lg shadow">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-semibold">💬 Lịch sử hỏi đáp</h2>
          <div className="flex gap-2">
            <button onClick={handleClearAllHistory} className="bg-red-500 hover:bg-red-600 text-white px-3 py-1 rounded-lg text-sm">Xóa toàn bộ</button>
          </div>
        </div>
        {history.length === 0 ? (
          <p className="text-gray-500">Chưa có lịch sử.</p>
        ) : (
          <div className="space-y-4">
            {history.map((h) => (
              <div key={h.id} className="p-3 border rounded-lg bg-gray-50">
                <p className="text-sm text-gray-700">
                  <span className="font-semibold">User {h.user_id}</span> hỏi PDF{" "}
                  <span className="font-semibold">{h.pdf_id}</span>:
                </p>
                <p className="text-gray-600 mt-1">❓ {h.question}</p>
                <p className="text-gray-800 mt-1">✅ {h.answer}</p>
                <div className="mt-2 flex gap-2">
                  <button onClick={() => handleDeleteHistoryItem(h.id)} className="bg-yellow-500 hover:bg-yellow-600 text-white px-2 py-1 rounded text-sm">Xóa</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default Admin;
