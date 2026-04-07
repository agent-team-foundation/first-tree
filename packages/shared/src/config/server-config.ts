import { z } from "zod";
import { defineConfig, field, optional } from "./schema.js";
import { getConfig } from "./singleton.js";
import type { InferConfig } from "./types.js";

export const serverConfigSchema = defineConfig({
  database: {
    url: field(z.string(), {
      env: "FIRST_TREE_HUB_DATABASE_URL",
      auto: "docker-pg",
      prompt: {
        message: "PostgreSQL:",
        type: "select",
        choices: [
          { name: "Auto-provision via Docker", value: "__auto__" },
          { name: "Provide connection URL", value: "__input__" },
        ],
      },
    }),
    provider: field(z.enum(["docker", "external"]).default("docker")),
  },
  server: {
    port: field(z.number().default(8000), { env: "FIRST_TREE_HUB_PORT" }),
    host: field(z.string().default("127.0.0.1"), { env: "FIRST_TREE_HUB_HOST" }),
  },
  secrets: {
    jwtSecret: field(z.string(), {
      env: "FIRST_TREE_HUB_JWT_SECRET",
      auto: "random:base64url:32",
      secret: true,
    }),
    encryptionKey: field(z.string(), {
      env: "FIRST_TREE_HUB_ENCRYPTION_KEY",
      auto: "random:hex:32",
      secret: true,
    }),
  },
  contextTree: optional({
    repo: field(z.string(), {
      env: "FIRST_TREE_HUB_CONTEXT_TREE_REPO",
      prompt: { message: "Context Tree repo URL (e.g. https://github.com/org/first-tree):" },
    }),
    branch: field(z.string().default("main")),
  }),
  github: {
    token: field(z.string().optional(), {
      env: "FIRST_TREE_HUB_GITHUB_TOKEN",
      secret: true,
    }),
    webhookSecret: field(z.string().optional(), {
      env: "FIRST_TREE_HUB_GITHUB_WEBHOOK_SECRET",
      secret: true,
    }),
  },
  cors: optional({
    origin: field(z.string(), { env: "FIRST_TREE_HUB_CORS_ORIGIN" }),
  }),
  rateLimit: optional({
    max: field(z.number().default(100), { env: "FIRST_TREE_HUB_RATE_LIMIT_MAX" }),
    loginMax: field(z.number().default(5), { env: "FIRST_TREE_HUB_RATE_LIMIT_LOGIN_MAX" }),
    webhookMax: field(z.number().default(60), { env: "FIRST_TREE_HUB_RATE_LIMIT_WEBHOOK_MAX" }),
  }),
  kael: optional({
    endpoint: field(z.string(), { env: "KAEL_ENDPOINT" }),
    apiKey: field(z.string(), { env: "KAEL_API_KEY", secret: true }),
    /** Public URL of this Hub server, reachable from Kael for API callbacks */
    hubPublicUrl: field(z.string(), { env: "FIRST_TREE_HUB_PUBLIC_URL" }),
  }),
});

export type ServerConfig = InferConfig<typeof serverConfigSchema>;

/** Typed accessor for server configuration singleton. */
export function getServerConfig(): ServerConfig {
  return getConfig<ServerConfig>();
}
