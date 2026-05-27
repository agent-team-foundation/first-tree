import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { monorepoSourceAliases } from "../../scripts/vitest-aliases.js";

// Web tests don't render React, but many of them import `.tsx` modules
// (e.g. `pages/team/index.tsx` for its non-component helpers) — the React
// plugin is needed at transform time to strip the JSX.
export default defineConfig({
  plugins: [react()],
  test: {
    coverage: {
      include: [
        "src/auth/redirect-from-state.ts",
        "src/lib/agent-status-view.ts",
        "src/pages/onboarding/copy.ts",
        "src/pages/onboarding/steps.ts",
        "src/utils/agent-state.ts",
        "src/utils/chat-gap.ts",
        "src/utils/onboarding-team-name.ts",
        "src/utils/requires-mention.ts",
      ],
    },
  },
  resolve: {
    alias: monorepoSourceAliases,
  },
});
