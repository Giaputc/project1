import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import api from "../api.js";

function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const navigate = useNavigate();

  const handleLogin = async () => {
    try {
      const res = await api.post("/auth/login", { username, password });
      localStorage.setItem("token", res.data.access_token);
      navigate("/admin");
    } catch (err) {
      alert("❌ Sai tài khoản hoặc mật khẩu!");
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100">
      <div className="bg-white shadow-lg rounded-lg p-8 w-96">
        <h2 className="text-2xl font-bold text-center mb-6">🔐 Admin Login</h2>
        <input
          type="text"
          placeholder="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="w-full border p-2 rounded-lg mb-3"
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full border p-2 rounded-lg mb-4"
        />
        <button
          onClick={handleLogin}
          className="w-full bg-blue-500 hover:bg-blue-600 text-white py-2 rounded-lg"
        >
          Login
        </button>
      </div>
    </div>
  );
}

export default Login;
