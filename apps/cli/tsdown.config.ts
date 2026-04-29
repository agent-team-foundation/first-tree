import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: "esm",
    platform: "node",
    target: "node22",
    external: [/^node:/],
    noExternal: [/^@first-tree\//],
    outDir: "dist",
  },
  // Separate minimal bundle for the Claude Code statusline hook. Called
  // many times per session by the harness; must have zero npm deps and
  // load in <30ms. Source is shared with packages/auto/dist/auto-statusline.js
  // so the hook works whether the user invokes via `first-tree` (this
  // bundle) or via `node $packages_auto_dir/dist/auto-statusline.js`.
  // dts disabled for this entry: the source lives in packages/auto and is
  // not part of apps/cli's tsconfig program, so rolldown-plugin-dts can't
  // emit declarations for it. The bundle is consumed by `node` directly,
  // so .d.ts is unnecessary.
  {
    entry: { "auto-statusline": "../../packages/auto/src/statusline.ts" },
    format: "esm",
    platform: "node",
    target: "node22",
    external: [/^node:/],
    outDir: "dist",
    dts: false,
  },
]);
