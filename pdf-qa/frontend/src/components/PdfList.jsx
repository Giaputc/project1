import api, { downloadFile } from "../api";

export default function PdfList({ pdfs, selectedPdf, setSelectedPdf, onAsk }) {

  const downloadPdf = (filename) => {
    downloadFile(filename);
  };
  return (
    <div className="w-1/4 border p-2 h-[80vh] overflow-y-auto">
      <h3 className="text-lg mb-2 font-bold">PDF List</h3>
      <ul>
        {pdfs.map(pdf => (
          <li
            key={pdf.id}
            className={`p-2 mb-2 rounded ${
              selectedPdf?.id === pdf.id ? "bg-blue-200" : "bg-gray-100"
            }`}
          >
            <div
              className="cursor-pointer"
              onClick={() => setSelectedPdf(pdf)}
            >
              {pdf.filename}
            </div>
            <div className="mt-2 flex gap-2">
              <button
              className="mt-1 text-sm bg-blue-500 text-white px-2 py-1 rounded hover:bg-blue-600"
              onClick={() => onAsk(pdf.id)}
            >
              Hỏi PDF
            </button>
              <button
                className="mt-1 text-sm bg-green-600 text-white px-2 py-1 rounded hover:bg-green-700"
                onClick={() => downloadPdf(pdf.filename)}
              >
                Tải PDF
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
