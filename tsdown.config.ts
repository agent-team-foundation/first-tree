import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["src/cli.ts"],
    format: "esm",
    outDir: "dist",
    loader: {
      ".md": "text",
    },
  },
  // Separate minimal bundle for the statusline hook. Called many times per
  // session by the Claude Code statusline hook; must have zero npm deps
  // and load in <30ms. Keep this entry self-contained (no `./cli` imports,
  // no ink, no zod).
  {
    entry: ["src/products/breeze/engine/statusline.ts"],
    format: "esm",
    outDir: "dist",
    outputOptions: {
      entryFileNames: "breeze-statusline.js",
    },
  },
]);
