import React, { useState, useEffect } from "react";
import api from "../api";

export default function Home() {
  const [pdfs, setPdfs] = useState([]);
  const [selectedPdf, setSelectedPdf] = useState(null);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [images, setImages] = useState([]);
  const [askAll, setAskAll] = useState(false);
  const [loading, setLoading] = useState(false);

  // Tải danh sách PDF
  useEffect(() => {
    api
      .get("/pdf/")
      .then((res) => setPdfs(res.data))
      .catch((err) => console.error("Lỗi tải PDF:", err));
  }, []);

  // prefer the shared helper exported from ../api
  const downloadPdf = (filename) => {
    // import named helper to preserve auth headers
    // we call the shared downloadFile from module level since api is default export
    // but keep this wrapper in case of future customization
    import("../api").then((mod) => mod.downloadFile(filename));
  };

  const handleAsk = async () => {
    if (!question.trim()) {
      alert("Nhập câu hỏi!");
      return;
    }

    setLoading(true);
    setAnswer("");
    setImages([]);

    try {
      let res;
      if (askAll) {
        res = await api.post(
          "/pdf/ask_all",
          { question }
        );
      } else {
        if (!selectedPdf) {
          alert("Bạn phải chọn 1 PDF!");
          setLoading(false);
          return;
        }
        res = await api.post(
          `/pdf/ask/${selectedPdf.id}`,
          { question }
        );
      }

      const { answer, images } = res.data;
      setAnswer(answer || "Không tìm thấy câu trả lời phù hợp.");
      setImages(images || []);

    } catch (err) {
      console.error("Lỗi hỏi PDF:", err.response?.data || err.message);
      setAnswer("❌ Có lỗi xảy ra khi hỏi PDF.");
    } finally {
      setLoading(false);
      setQuestion("");
    }
  };

  return (
    <div className="min-h-screen bg-gray-100 p-6">
      <h1 className="text-2xl font-bold mb-6">Hỏi đáp PDF (Text + Ảnh)</h1>

      {/* Chọn chế độ */}
      <div className="mb-4 flex gap-3">
        <button
          onClick={() => {
            setAskAll(false);
            setSelectedPdf(null);
            setAnswer("");
            setImages([]);
          }}
          className={`px-4 py-2 rounded-lg ${
            !askAll ? "bg-blue-500 text-white" : "bg-gray-200"
          }`}
        >
          Hỏi theo File
        </button>
        <button
          onClick={() => {
            setAskAll(true);
            setSelectedPdf(null);
            setAnswer("");
            setImages([]);
          }}
          className={`px-4 py-2 rounded-lg ${
            askAll ? "bg-blue-500 text-white" : "bg-gray-200"
          }`}
        >
          Hỏi toàn bộ PDF
        </button>
      </div>

      {/* Danh sách PDF */}
      {!askAll && (
        <div className="bg-white p-6 rounded-lg shadow mb-6">
          <h2 className="text-lg font-semibold mb-3">📚 Danh sách PDF</h2>
          <ul className="space-y-2">
            {pdfs.map((pdf) => (
              <li
                key={pdf.id}
                onClick={() => setSelectedPdf(pdf)}
                className={`cursor-pointer px-3 py-2 rounded-lg shadow-sm ${
                  selectedPdf?.id === pdf.id
                    ? "bg-blue-500 text-white"
                    : "bg-gray-100 hover:bg-gray-200"
                }`}
                >
                <div className="flex justify-between items-center">
                  <span>{pdf.filename}</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      downloadPdf(pdf.filename);
                    }}
                    className="text-xs bg-green-600 text-white px-2 py-1 rounded hover:bg-green-700"
                  >
                    Tải PDF
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Box hỏi */}
      <div className="bg-white p-6 rounded-lg shadow mb-6">
        <h3 className="text-lg font-semibold mb-3">
          Đặt câu hỏi{" "}
          {!askAll && selectedPdf ? (
            <span className="text-blue-600">({selectedPdf.filename})</span>
          ) : askAll ? (
            <span className="text-blue-600">(Toàn bộ PDF)</span>
          ) : (
            ""
          )}
        </h3>
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          className="w-full border p-2 rounded-lg mb-3"
          rows={3}
          placeholder="Nhập câu hỏi của bạn..."
        />
        <button
          onClick={handleAsk}
          className="bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded-lg"
          disabled={loading}
        >
          {loading ? "⏳ Đang xử lý..." : "Hỏi"}
        </button>
      </div>

      {/* Kết quả */}
      {answer && (
        <div className="bg-gray-50 border border-gray-300 p-4 rounded-lg shadow">
          <h4 className="font-semibold mb-3">💡 Câu trả lời</h4>
          <p className="mb-4 whitespace-pre-line">{answer}</p>

          {images && images.length > 0 && (
            <div>
              <h5 className="font-semibold mb-2">🖼️ Ảnh liên quan:</h5>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                {images.map((img, i) => (
                  <div key={i} className="rounded-lg overflow-hidden shadow border">
                    <img
                      src={img.base64}
                      alt={`Trang ${img.page}`}
                      className="w-full h-auto object-contain bg-gray-50"
                      style={{ maxHeight: '300px' }}
                    />
                    <p className="text-center text-sm text-gray-600 mt-1 p-2 bg-gray-100">
                      Trang {img.page}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
