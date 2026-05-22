import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: "esm",
    platform: "node",
    target: "node22",
    // `react-devtools-core` is an optional dev-only dep of `ink` that is
    // never reachable at runtime in our CLI. Mark it external so rolldown
    // doesn't emit an UNRESOLVED_IMPORT warning during the build.
    external: [/^node:/, "react-devtools-core"],
    noExternal: [/^@first-tree\//],
    outDir: "dist",
  },
  // Separate minimal bundle for the Claude Code statusline hook. Called
  // many times per session by the harness; must have zero npm deps and
  // load in <30ms. Source is shared with packages/github-scan/dist/github-scan-statusline.js
  // so the hook works whether the user invokes via `first-tree` (this
  // bundle) or via `node $package_dir/dist/github-scan-statusline.js`.
  // dts disabled for this entry: the source lives in packages/github-scan and is
  // not part of apps/cli's tsconfig program, so rolldown-plugin-dts can't
  // emit declarations for it. The bundle is consumed by `node` directly,
  // so .d.ts is unnecessary.
  {
    entry: {
      "github-scan-statusline": "../../packages/github-scan/src/github-scan/engine/statusline.ts",
    },
    format: "esm",
    platform: "node",
    target: "node22",
    external: [/^node:/],
    outDir: "dist",
    dts: false,
  },
]);
