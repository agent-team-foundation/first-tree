import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: {
      cli: "src/cli.ts",
      index: "src/index.ts",
    },
    format: "esm",
    platform: "node",
    target: "node22",
    external: [/^node:/],
    outDir: "dist",
    clean: false,
  },
  {
    entry: ["src/github-scan/engine/statusline.ts"],
    format: "esm",
    platform: "node",
    target: "node22",
    external: [/^node:/],
    outDir: "dist",
    clean: false,
    dts: false,
    outputOptions: {
      entryFileNames: "github-scan-statusline.js",
    },
  },
]);
