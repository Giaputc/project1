import { useState } from "react";

export default function ChatBox({ messages, sendQuestion, selectedPdf }) {
  const [question, setQuestion] = useState("");

  const handleSend = () => {
    if (!question) return;
    sendQuestion(question);
    setQuestion("");
  };

  return (
    <div className="flex-1 border p-2 flex flex-col h-[80vh]">
      <h3 className="text-lg mb-2 font-bold">
        {selectedPdf ? `Chat: ${selectedPdf.filename}` : "Chọn PDF để hỏi"}
      </h3>
      <div className="flex-1 overflow-y-auto mb-2">
        {messages.map((msg, idx) => (
          <div key={idx} className="mb-2 border-b pb-1">
            <p><strong>Q:</strong> {msg.question}</p>
            <p><strong>A:</strong> {msg.answer}</p>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          className="flex-1 border p-1"
          value={question}
          onChange={e => setQuestion(e.target.value)}
          placeholder="Nhập câu hỏi..."
        />
        <button className="bg-blue-500 text-white px-3" onClick={handleSend}>Send</button>
      </div>
    </div>
  );
}
