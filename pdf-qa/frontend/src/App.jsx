import React from "react";
import { BrowserRouter as Router, Routes, Route, Link } from "react-router-dom";
import Home from "./pages/Home";
import Admin from "./pages/Admin";
import Login from "./pages/Login"; // thêm dòng này

function App() {
  return (
    <Router>
      <div>
        <nav style={{ padding: "10px", borderBottom: "1px solid #ccc" }}>
          <Link to="/" style={{ marginRight: "15px" }}>Home</Link>
          <Link to="/login">Login</Link>
        </nav>

        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/login" element={<Login />} /> {/* thêm route login */}
          <Route path="/admin" element={<Admin />} />
        </Routes>
      </div>
    </Router>
  );
}

export default App;
