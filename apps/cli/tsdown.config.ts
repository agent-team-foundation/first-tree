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
]);
