import { z } from "zod";
import { logFormatSchema, logLevelSchema } from "../observability/logger-core.js";
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
    webhookSecret: field(z.string().optional(), {
      env: "FIRST_TREE_HUB_GITHUB_WEBHOOK_SECRET",
      secret: true,
    }),
    allowedOrg: field(z.string().optional(), {
      env: "FIRST_TREE_HUB_GITHUB_ALLOWED_ORG",
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
  feedback: optional({
    /**
     * GitHub repo where feedback issues are filed (owner/name).
     * HEARBACK_FEEDBACK_REPO is distinct from FIRST_TREE_HUB_GITHUB_* vars so
     * the feedback token can be scoped narrowly (issues:write on a single repo)
     * without widening the hub's Context Tree access.
     */
    repo: field(z.string(), { env: "HEARBACK_FEEDBACK_REPO" }),
    githubToken: field(z.string(), { env: "HEARBACK_GITHUB_TOKEN", secret: true }),
    llm: optional({
      apiKey: field(z.string(), { env: "LLM_API_KEY", secret: true }),
      baseUrl: field(z.string().optional(), { env: "LLM_BASE_URL" }),
      model: field(z.string().optional(), { env: "LLM_MODEL" }),
    }),
    /**
     * Trust x-forwarded-for for rate-limit attribution. Default false; set true
     * when the hub sits behind a proxy you control (CDN, ingress). Otherwise
     * clients can spoof the header and bypass per-ip limits.
     */
    trustProxyHeaders: field(z.boolean().default(false), { env: "HEARBACK_TRUST_PROXY_HEADERS" }),
  }),
  observability: {
    logging: {
      level: field(logLevelSchema.default("info"), {
        env: "FIRST_TREE_HUB_LOG_LEVEL",
      }),
      /**
       * Output format. Defaults to `json` in production and `pretty` elsewhere —
       * pretty is for humans, json is for log collectors (Loki, CloudWatch, Vector).
       */
      format: field(logFormatSchema.default(process.env.NODE_ENV === "production" ? "json" : "pretty")),
      /** Minimum pino level whose records are bridged onto the currently-active span. */
      bridgeToSpanLevel: field(z.enum(["error", "warn", "off"]).default("error")),
    },
    tracing: optional({
      /**
       * OTLP endpoint. Non-empty value enables tracing; empty string disables it.
       * There is deliberately no separate `enabled` flag — endpoint presence is the switch.
       */
      endpoint: field(z.string(), { env: "FIRST_TREE_HUB_OTEL_ENDPOINT" }),
      /**
       * Exporter headers, serialized as `key1=value1,key2=value2` (one string — avoids
       * env-var record coercion issues). Secret because it typically holds the write token.
       */
      headers: field(z.string().default(""), { env: "FIRST_TREE_HUB_OTEL_HEADERS", secret: true }),
      exporter: field(z.enum(["otlp-http", "otlp-grpc"]).default("otlp-http")),
      serviceName: field(z.string().default("first-tree-hub")),
      /**
       * Deployment environment label. Emitted as the OTel resource attribute
       * `deployment.environment.name` — trace backends (Logfire, Honeycomb, …)
       * use this to let one project span many environments while still
       * letting you filter by env in the UI.
       */
      environment: field(z.string().default("development"), {
        env: "FIRST_TREE_HUB_OTEL_ENVIRONMENT",
      }),
      sampleRate: field(z.number().min(0).max(1).default(1)),
    }),
  },
});

export type ServerConfig = InferConfig<typeof serverConfigSchema>;

/** Typed accessor for server configuration singleton. */
export function getServerConfig(): ServerConfig {
  return getConfig<ServerConfig>();
}
