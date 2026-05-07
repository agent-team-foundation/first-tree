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
    /**
     * Public-facing URL of this Hub server. Required in production — used to:
     *   1. Stamp the `iss` claim on connect tokens so `first-tree-hub connect`
     *      can derive the hub URL with no extra arg.
     *   2. Build invite-link URLs surfaced to admins.
     *   3. Construct the OAuth callback URL the GitHub app redirects back to.
     * Dev environments may omit it — we fall back to the request's host header
     * for local quickstart, and the boot check below only fires when
     * `NODE_ENV === 'production'`.
     */
    publicUrl: field(z.string().optional(), { env: "FIRST_TREE_HUB_PUBLIC_URL" }),
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
  /**
   * JWT lifetimes. All accept the `ms`-style format ("30m", "30d", "12h", …)
   * understood by `jose`'s `setExpirationTime`.
   *
   * Refresh tokens slide: every successful `/auth/refresh` issues a fresh
   * pair, so an active client never hits the absolute expiry. The default
   * 30d window is the safety net for clients that go offline for a while —
   * tighten it for high-security deployments, loosen for kiosk/lab boxes.
   */
  auth: {
    accessTokenExpiry: field(z.string().default("30m"), { env: "FIRST_TREE_HUB_AUTH_ACCESS_TOKEN_EXPIRY" }),
    refreshTokenExpiry: field(z.string().default("30d"), { env: "FIRST_TREE_HUB_AUTH_REFRESH_TOKEN_EXPIRY" }),
    connectTokenExpiry: field(z.string().default("10m"), { env: "FIRST_TREE_HUB_AUTH_CONNECT_TOKEN_EXPIRY" }),
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
  oauth: optional({
    /**
     * GitHub OAuth App credentials for SaaS sign-in. The "half configured"
     * shape (only one of clientId/clientSecret set) is rejected at boot so a
     * misconfigured production instance can't accidentally expose the
     * dev-callback bypass with no real OAuth wired up.
     */
    github: optional({
      clientId: field(z.string(), { env: "FIRST_TREE_HUB_GITHUB_OAUTH_CLIENT_ID" }),
      clientSecret: field(z.string(), {
        env: "FIRST_TREE_HUB_GITHUB_OAUTH_CLIENT_SECRET",
        secret: true,
      }),
    }),
  }),
  cors: optional({
    origin: field(z.string(), { env: "FIRST_TREE_HUB_CORS_ORIGIN" }),
  }),
  /**
   * Trust upstream proxy headers (e.g. `x-forwarded-for`) for `req.ip`. Required
   * in production where Hub sits behind Cloudflare / a reverse proxy — otherwise
   * `req.ip` resolves to the proxy and every IP-keyed rate-limit key collapses
   * to the same value. Default false; safe for local development.
   */
  trustProxy: field(z.boolean().default(false), { env: "FIRST_TREE_HUB_TRUST_PROXY" }),
  rateLimit: optional({
    /** Default cap applied to all routes that don't override; overridden per-route below. */
    max: field(z.number().default(100), { env: "FIRST_TREE_HUB_RATE_LIMIT_MAX" }),
    /** Cap on `/auth/login`, `/auth/connect-token`, and other token-issuing paths. */
    loginMax: field(z.number().default(5), { env: "FIRST_TREE_HUB_RATE_LIMIT_LOGIN_MAX" }),
    /** Cap on `/webhooks/github`. */
    webhookMax: field(z.number().default(60), { env: "FIRST_TREE_HUB_RATE_LIMIT_WEBHOOK_MAX" }),
    /**
     * Per-agent cap on outbound message writes (`POST /agent/chats/:chatId/messages`
     * and `POST /agent/agents/:name/messages`). Tighter than the global default
     * because automated agents are the common loop-failure mode.
     */
    agentMessageMax: field(z.number().default(30), { env: "FIRST_TREE_HUB_RATE_LIMIT_AGENT_MESSAGE_MAX" }),
  }),
  ws: optional({
    /**
     * Maximum payload size (bytes) for a single WebSocket frame on the
     * client/admin sockets. Protects the server against single-frame OOM via a
     * malicious or buggy client. Default 256 KiB — large enough to fit
     * legitimate `session:event` frames whose `tool_call.payload.args` may
     * carry full file contents (Claude Code's Write/Edit `new_string`, Bash
     * heredoc payloads, MCP tools forwarding diffs/AST), while still bounding
     * worst-case memory per frame. Image content travels via HTTP, not WS.
     * Real OOM attackers send MB+, not KiB — this is a guardrail, not a DoS
     * shield. Tighten or loosen via `FIRST_TREE_HUB_WS_MAX_PAYLOAD` once we
     * have production P99 frame-size data.
     */
    maxPayload: field(z.number().int().min(1024).default(262_144), { env: "FIRST_TREE_HUB_WS_MAX_PAYLOAD" }),
  }),
  inbox: optional({
    /**
     * Backpressure cap on per-agent in-flight (un-acked) `inbox:deliver`
     * frames. Once reached the server stops pushing for that agent until an
     * ack arrives — leftover entries stay `pending` in the DB and get
     * replayed via the post-ack backlog scan. See proposal §3.5.
     *
     * The WS data plane itself is always on; cross-version compatibility is
     * handled by the per-socket `wireCapabilities.wsInboxDeliver` opt-in
     * negotiated during `client:register` (proposal §3.6). An old client
     * that doesn't send the flag automatically gets the legacy `new_message`
     * doorbell + HTTP poll; a new client gets push frames.
     */
    maxInFlightPerAgent: field(z.number().int().min(1).max(1024).default(32), {
      env: "FIRST_TREE_HUB_INBOX_MAX_IN_FLIGHT_PER_AGENT",
    }),
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
