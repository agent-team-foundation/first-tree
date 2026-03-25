import { z } from "zod";
import { defineConfig, field } from "./schema.js";
import { getConfig } from "./singleton.js";
import type { InferConfig } from "./types.js";

export const clientConfigSchema = defineConfig({
  server: {
    url: field(z.string(), {
      env: "AGENT_HUB_SERVER_URL",
      prompt: { message: "Server URL:", default: "http://localhost:8000" },
    }),
  },
  logLevel: field(z.enum(["debug", "info", "warn", "error"]).default("info"), { env: "AGENT_HUB_LOG_LEVEL" }),
});

export type ClientConfig = InferConfig<typeof clientConfigSchema>;

/** Typed accessor for client configuration singleton. */
export function getClientConfig(): ClientConfig {
  return getConfig<ClientConfig>();
}
