import { z } from "zod";
import { defineConfig, field, optional } from "./schema.js";
import { getConfig } from "./singleton.js";
import type { InferConfig } from "./types.js";

export const serverConfigSchema = defineConfig({
  database: {
    url: field(z.string(), {
      env: "DATABASE_URL",
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
    port: field(z.number().default(8000), { env: "PORT" }),
    host: field(z.string().default("127.0.0.1"), { env: "HOST" }),
  },
  secrets: {
    jwtSecret: field(z.string(), {
      env: "JWT_SECRET",
      auto: "random:base64url:32",
      secret: true,
    }),
    encryptionKey: field(z.string(), {
      env: "ENCRYPTION_KEY",
      auto: "random:hex:32",
      secret: true,
    }),
  },
  contextTree: {
    repo: field(z.string(), {
      env: "CONTEXT_TREE_REPO",
      prompt: { message: "Context Tree repo URL (e.g. https://github.com/org/first-tree):" },
    }),
    branch: field(z.string().default("main")),
    syncInterval: field(z.number().default(60)),
  },
  github: {
    token: field(z.string(), {
      env: "GITHUB_TOKEN",
      secret: true,
      prompt: {
        message: "GitHub token (create at https://github.com/settings/tokens → repo scope):",
        type: "password",
      },
    }),
  },
  web: optional({
    distPath: field(z.string(), { env: "WEB_DIST_PATH" }),
  }),
  webhooks: optional({
    githubSecret: field(z.string(), { env: "GITHUB_WEBHOOK_SECRET", secret: true }),
  }),
});

export type ServerConfig = InferConfig<typeof serverConfigSchema>;

/** Typed accessor for server configuration singleton. */
export function getServerConfig(): ServerConfig {
  return getConfig<ServerConfig>();
}
