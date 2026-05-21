import { z } from "zod";
import { logLevelSchema } from "../observability/logger-core.js";
import { UPDATE_POLICIES, UPDATE_POLICY_DEFAULT } from "./phase.js";
import { defineConfig, field } from "./schema.js";
import { getConfig } from "./singleton.js";
import type { InferConfig } from "./types.js";

export const updatePolicySchema = z.enum(UPDATE_POLICIES);

export const clientConfigSchema = defineConfig({
  server: {
    url: field(z.string(), {
      env: "FIRST_TREE_SERVER_URL",
      prompt: { message: "Server URL:", default: "http://localhost:8000" },
    }),
  },
  client: {
    // Stable per-machine client identifier. Auto-generated on first start and
    // written back to client.yaml so the SDK keeps the same id across
    // restarts — agents pin to `clients.id` on the server, so a fresh random
    // id every run would orphan every pinned agent (Rule R-RUN WRONG_CLIENT).
    id: field(z.string().regex(/^client_[a-f0-9]{8}$/), {
      auto: "client-id",
      env: "FIRST_TREE_CLIENT_ID",
    }),
  },
  update: {
    policy: field(updatePolicySchema.default(UPDATE_POLICY_DEFAULT), {
      env: "FIRST_TREE_UPDATE_POLICY",
    }),
    restart_quiet_seconds: field(z.number().int().min(1).max(3600).default(30), {
      env: "FIRST_TREE_UPDATE_RESTART_QUIET_SECONDS",
    }),
    restart_check_interval_seconds: field(z.number().int().min(5).max(300).default(10), {
      env: "FIRST_TREE_UPDATE_RESTART_CHECK_INTERVAL_SECONDS",
    }),
    prompt_timeout_seconds: field(z.number().int().min(10).max(600).default(60), {
      env: "FIRST_TREE_UPDATE_PROMPT_TIMEOUT_SECONDS",
    }),
  },
  logLevel: field(logLevelSchema.default("info"), { env: "FIRST_TREE_LOG_LEVEL" }),
});

export type ClientConfig = InferConfig<typeof clientConfigSchema>;

/** Typed accessor for client configuration singleton. */
export function getClientConfig(): ClientConfig {
  return getConfig<ClientConfig>();
}
