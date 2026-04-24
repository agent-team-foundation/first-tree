import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Deploying under GitHub Pages at `https://<org>.github.io/first-tree-hub/`
// so the build must be rooted at `/first-tree-hub/`. Set via env to keep the
// local dev server at `/`.
const BASE = process.env.VITE_BASE ?? "/";

export default defineConfig({
  base: BASE,
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
