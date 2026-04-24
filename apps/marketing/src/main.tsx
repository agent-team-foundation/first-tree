import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import { LandingPage } from "./pages/landing.js";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("root element missing");

// Base path aligns with vite.config.ts so GitHub Pages routing works.
const BASENAME = import.meta.env.BASE_URL.replace(/\/$/, "");

createRoot(root).render(
  <StrictMode>
    <BrowserRouter basename={BASENAME || "/"}>
      <Routes>
        <Route path="/" element={<LandingPage />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
