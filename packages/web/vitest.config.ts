import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { monorepoSourceAliases } from "../../scripts/vitest-aliases.js";

// Web tests don't render React, but many of them import `.tsx` modules
// (e.g. `pages/team/index.tsx` for its non-component helpers) — the React
// plugin is needed at transform time to strip the JSX.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: monorepoSourceAliases,
  },
});
