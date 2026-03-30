import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: "esm",
  outDir: "dist",
  loader: {
    ".md": "text",
  },
});
