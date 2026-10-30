import axios from "axios";

const API_URL = "http://localhost:8000";

const api = axios.create({
  baseURL: API_URL,
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem("token");
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Thêm hàm setAuthToken để export
export const setAuthToken = (token) => {
  if (token) {
    localStorage.setItem("token", token);
  } else {
    localStorage.removeItem("token");
  }
};

// Helper: download a PDF with confirmation then fetch blob and trigger a save
export const downloadFile = async (filename, options = {}) => {
  const confirmMessage = options.confirmMessage || `Bạn có muốn tải xuống '${filename}' không?`;
  if (!window.confirm(confirmMessage)) return false;

  try {
    // Use the same axios instance so auth headers are applied
    const resp = await api.get(`/pdf/${encodeURIComponent(filename)}`, { responseType: 'blob' });
    // success -> create blob and trigger download
    const blob = new Blob([resp.data], { type: resp.headers['content-type'] || 'application/pdf' });
    const blobUrl = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();

    // revoke after a short delay
    setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
    return true;
  } catch (err) {
    // Log details to help debugging (server status/messages)
    console.error('Download failed (blob fetch)', err);
    const status = err?.response?.status;
    const text = err?.response?.data;
    // user-friendly messages
    if (status === 404) {
      alert(`File không tìm thấy trên server (404).`);
      return false;
    }

    // If fetching as blob fails, try a fallback: open the file URL in a new tab
    try {
      const base = api.defaults.baseURL || '';
      const fallbackUrl = `${base}/pdf/${encodeURIComponent(filename)}`;
      // open in new tab so browser will either show PDF or ask to download
      window.open(fallbackUrl, '_blank', 'noopener');
      return true;
    } catch (fallbackErr) {
      console.error('Fallback open failed', fallbackErr, 'serverResponse:', status, text);
      alert('Tải file thất bại. Vui lòng thử lại.');
      return false;
    }
  }
};

export default api;
