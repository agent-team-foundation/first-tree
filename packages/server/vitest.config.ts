import { defineConfig } from "vitest/config";
import { monorepoSourceAliases } from "../../scripts/vitest-aliases.js";
import { MAX_FORKS } from "./src/__tests__/test-config.js";

export default defineConfig({
  test: {
    globalSetup: "./src/__tests__/global-setup.ts",
    setupFiles: ["./src/__tests__/setup.ts"],
    fileParallelism: true,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      include: [
        "src/bootstrap-state.ts",
        "src/config.ts",
        "src/types.ts",
        "src/api/adapters.ts",
        "src/api/readyz.ts",
        "src/api/agent/inbox.ts",
        "src/api/orgs/adapters.ts",
        "src/api/orgs/clients.ts",
        "src/api/orgs/members.ts",
        "src/db/schema/adapter-agent-mappings.ts",
        "src/db/schema/adapter-chat-mappings.ts",
        "src/db/schema/adapter-configs.ts",
        "src/db/schema/adapter-message-references.ts",
        "src/db/schema/agent-configs.ts",
        "src/db/schema/attentions.ts",
        "src/db/schema/chat-membership.ts",
        "src/db/schema/chat-user-state.ts",
        "src/db/schema/chats.ts",
        "src/db/schema/inbox-entries.ts",
        "src/db/schema/index.ts",
        "src/db/schema/members.ts",
        "src/db/schema/messages.ts",
        "src/db/schema/notifications.ts",
        "src/db/schema/organizations.ts",
        "src/db/schema/pending-questions.ts",
        "src/db/schema/server-instances.ts",
        "src/db/schema/session-events.ts",
        "src/db/schema/users.ts",
        "src/observability/index.ts",
        "src/observability/span-attrs.ts",
        "src/scope/types.ts",
        "src/services/access-control.ts",
        "src/services/chat-archive.ts",
        "src/services/participant-invite.ts",
        "src/services/feishu/types.ts",
      ],
    },
    pool: "forks",
    poolOptions: {
      forks: {
        // Re-use the worker process across files so we don't pay fastify +
        // module-graph load on every file. Combined with the low maxForks
        // cap from test-config.ts, leaked module state stays bounded.
        isolate: false,
        maxForks: MAX_FORKS,
        minForks: 1,
      },
    },
  },
  resolve: {
    alias: monorepoSourceAliases,
  },
});
