import { z } from "zod";
import { logLevelSchema } from "../observability/logger-core.js";
import { defineConfig, field } from "./schema.js";
import { getConfig } from "./singleton.js";
import type { InferConfig } from "./types.js";

export const clientConfigSchema = defineConfig({
  server: {
    url: field(z.string(), {
      env: "FIRST_TREE_HUB_SERVER_URL",
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
      env: "FIRST_TREE_HUB_CLIENT_ID",
    }),
  },
  logLevel: field(logLevelSchema.default("info"), { env: "FIRST_TREE_HUB_LOG_LEVEL" }),
});

export type ClientConfig = InferConfig<typeof clientConfigSchema>;

/** Typed accessor for client configuration singleton. */
export function getClientConfig(): ClientConfig {
  return getConfig<ClientConfig>();
}
