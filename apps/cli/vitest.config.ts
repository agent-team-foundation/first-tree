import { defineConfig } from "vitest/config";
import { monorepoSourceAliases } from "../../scripts/vitest-aliases.js";

export default defineConfig({
  test: {
    coverage: {
      include: [
        "src/build-info.ts",
        "src/cli/output.ts",
        "src/commands/types.ts",
        "src/commands/agent/config/index.ts",
        "src/commands/daemon/index.ts",
        "src/commands/org/index.ts",
        "src/commands/tree/rule-layer.ts",
        "src/commands/tree/status.ts",
        "src/commands/tree/tree-templates.ts",
        "src/core/agent-messaging.ts",
        "src/core/channel.ts",
        "src/core/index.ts",
        "src/core/attention/index.ts",
      ],
    },
  },
  resolve: {
    alias: monorepoSourceAliases,
  },
});
