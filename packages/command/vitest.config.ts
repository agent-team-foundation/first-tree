import { defineConfig } from "vitest/config";
import { monorepoSourceAliases } from "../../scripts/vitest-aliases.js";

export default defineConfig({
  resolve: {
    alias: monorepoSourceAliases,
  },
});
