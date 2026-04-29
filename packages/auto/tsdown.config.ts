import { defineConfig } from "tsdown";

// Separate minimal bundle for the Claude Code statusline hook. Called
// many times per session; must have zero npm deps and load in <30ms.
// Keep this entry self-contained — no `./cli` imports, no ink, no zod.
export default defineConfig({
  entry: { "auto-statusline": "src/statusline.ts" },
  format: "esm",
  platform: "node",
  target: "node22",
  external: [/^node:/],
  outDir: "dist",
  // Don't clean dist: tsc -b also emits .d.ts files into this directory
  // (project references), and clobbering them breaks the root typecheck.
  clean: false,
  // dts disabled: tsc -b already emits the full declaration tree; this
  // entry only needs the runtime bundle.
  dts: false,
});
