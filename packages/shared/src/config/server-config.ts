import { join } from "node:path";
import { z } from "zod";
import { logFormatSchema, logLevelSchema } from "../observability/logger-core.js";
import { defaultDataDir } from "./resolver.js";
import { defineConfig, field, optional } from "./schema.js";
import { getConfig } from "./singleton.js";
import type { InferConfig } from "./types.js";

const optionalTrimmedStringSchema = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}, z.string().min(1).optional());

export const serverConfigSchema = defineConfig({
  /**
   * Which release channel this server speaks to. Single switch that drives
   * every CLI-facing identifier emitted by the server:
   *   - `prod`    → tells web/CLI to install `first-tree`           (bin `first-tree`)
   *   - `staging` → tells web/CLI to install `first-tree-staging`   (bin `first-tree-staging`)
   *   - `dev`     → no npm package; bootstrap commands skip `npm install -g`
   *
   * Set via `FIRST_TREE_CHANNEL` in the deployment env. Default `dev` makes
   * `pnpm --filter @first-tree/server dev` Just Work on a developer machine.
   *
   * See `packages/shared/src/channel/` for the full identity table.
   */
  channel: field(z.enum(["dev", "staging", "prod"]).default("dev"), {
    env: "FIRST_TREE_CHANNEL",
  }),
  database: {
    url: field(z.string(), {
      env: "FIRST_TREE_DATABASE_URL",
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
    port: field(z.number().default(8000), { env: "FIRST_TREE_PORT" }),
    host: field(z.string().default("127.0.0.1"), { env: "FIRST_TREE_HOST" }),
    /**
     * Public-facing URL of this First Tree server. Required in production — used to:
     *   1. Stamp the `iss` claim on connect tokens so `first-tree login`
     *      can derive the server URL with no extra arg.
     *   2. Build invite-link URLs surfaced to admins.
     *   3. Construct the OAuth callback URL the GitHub app redirects back to.
     * Dev environments may omit it — we fall back to the request's host header
     * for local quickstart, and the boot check below only fires when
     * `NODE_ENV === 'production'`.
     */
    publicUrl: field(z.string().optional(), { env: "FIRST_TREE_PUBLIC_URL" }),
  },
  workspace: {
    // Lazy default (function form): zod's `.default(value)` evaluates
    // `value` at schema-definition time, which would module-load-bake
    // `defaultDataDir()` against whatever `FIRST_TREE_HOME` happened to
    // be set when this file first loaded. `.default(() => ...)`
    // evaluates per parse instead, so the env is read at config-init
    // time — see `__tests__/no-toplevel-default-home-const.test.ts`
    // for the corresponding regression guard.
    root: field(
      z.string().default(() => join(defaultDataDir(), "workspaces")),
      { env: "FIRST_TREE_WORKSPACES_ROOT" },
    ),
  },
  secrets: {
    jwtSecret: field(z.string(), {
      env: "FIRST_TREE_JWT_SECRET",
      auto: "random:base64url:32",
      secret: true,
    }),
    encryptionKey: field(z.string(), {
      env: "FIRST_TREE_ENCRYPTION_KEY",
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
    accessTokenExpiry: field(z.string().default("30m"), { env: "FIRST_TREE_AUTH_ACCESS_TOKEN_EXPIRY" }),
    refreshTokenExpiry: field(z.string().default("30d"), { env: "FIRST_TREE_AUTH_REFRESH_TOKEN_EXPIRY" }),
    connectTokenExpiry: field(z.string().default("10m"), { env: "FIRST_TREE_AUTH_CONNECT_TOKEN_EXPIRY" }),
  },
  access: optional({
    /**
     * Invite-only entry gate for hosted environments that should accept new
     * users only through one organization. Empty / whitespace disables it.
     */
    allowedOrganizationId: field(optionalTrimmedStringSchema, {
      env: "FIRST_TREE_ALLOWED_ORGANIZATION_ID",
    }),
  }),
  // Context Tree (repo / branch / localPath) and GitHub integration
  // (webhook secret / allowed org) used to live here as global config.
  // They are now per-org settings in the `organization_settings` table —
  // admins configure them through Team Settings. See issue #255.
  // The server-managed Context Tree mirror mints a per-org GitHub App
  // installation token at request time (see `services/github-app-token.ts`);
  // no global token belongs here.
  oauth: optional({
    /**
     * GitHub App credentials. A single App installation simultaneously
     * unlocks user-OAuth, the webhook stream, and installation-token
     * minting. All five required fields must be set together; partial
     * configuration is rejected at boot for the same reason as the legacy
     * block — a half-wired App is worse than no App.
     *
     * Staging and prod each have a separate App with its own set of values;
     * the env file selects which to load.
     *
     * `privateKeyPem` is the raw PKCS#8 PEM (multi-line, starts with
     * `-----BEGIN PRIVATE KEY-----`). Self-hosters typically inline it via
     * a `.env` file with `\n` escapes; SaaS operators should source it
     * from their secret manager (a team-wide pattern is still TBD).
     */
    // `.min(1)` on every field: blank env values (empty string env
    // sets that resolve to `""` after substitution) must NOT make the
    // block resolve to a truthy object. The HMAC-empty-key forgery
    // path codex flagged (P1-8) trips exactly when `webhookSecret`
    // sneaks through as `""` — `createHmac("sha256", "")` is a valid
    // hash any attacker can reproduce. Same defense applies to all
    // five fields: empty appId would make App JWTs unverifiable
    // upstream, empty clientId would let GitHub round-trip an
    // anonymous OAuth, etc. Fail loud at Zod parse time.
    githubApp: optional({
      appId: field(z.string().min(1), { env: "FIRST_TREE_GITHUB_APP_ID" }),
      clientId: field(z.string().min(1), { env: "FIRST_TREE_GITHUB_APP_CLIENT_ID" }),
      clientSecret: field(z.string().min(1), {
        env: "FIRST_TREE_GITHUB_APP_CLIENT_SECRET",
        secret: true,
      }),
      privateKeyPem: field(z.string().min(1), {
        env: "FIRST_TREE_GITHUB_APP_PRIVATE_KEY",
        secret: true,
      }),
      webhookSecret: field(z.string().min(1), {
        env: "FIRST_TREE_GITHUB_APP_WEBHOOK_SECRET",
        secret: true,
      }),
      /**
       * The App's URL slug — the last path segment of
       * `https://github.com/apps/<slug>`. Used to build the
       * `installations/new` URL that surfaces GitHub's install dialog
       * (the OAuth `authorize` URL only triggers consent, never the
       * install picker, for users who haven't installed the App yet —
       * codex P1-1).
       *
       * Optional *within* the App block (unlike the five fields above):
       * the rest of the App surface — sign-in, webhook verification,
       * installation-token minting — works without it. Only the
       * "Install on GitHub" CTA in Settings needs the slug, and that
       * endpoint returns 503 when it's unset rather than blocking boot.
       */
      slug: field(z.string().min(1).optional(), { env: "FIRST_TREE_GITHUB_APP_SLUG" }),
    }),
  }),
  cors: optional({
    origin: field(z.string(), { env: "FIRST_TREE_CORS_ORIGIN" }),
  }),
  /**
   * Trust upstream proxy headers (e.g. `x-forwarded-for`) for `req.ip`. Required
   * in production where First Tree sits behind Cloudflare / a reverse proxy — otherwise
   * `req.ip` resolves to the proxy and every IP-keyed rate-limit key collapses
   * to the same value. Default false; safe for local development.
   */
  trustProxy: field(z.boolean().default(false), { env: "FIRST_TREE_TRUST_PROXY" }),
  rateLimit: optional({
    /** Default cap applied to all routes that don't override; overridden per-route below. */
    max: field(z.number().default(100), { env: "FIRST_TREE_RATE_LIMIT_MAX" }),
    /** Cap on `/auth/login`, `/auth/connect-token`, and other token-issuing paths. */
    loginMax: field(z.number().default(5), { env: "FIRST_TREE_RATE_LIMIT_LOGIN_MAX" }),
    /**
     * Cap on `/webhooks/github-app` (the GitHub App ingestion endpoint).
     * Sized for SaaS-wide aggregate traffic (single endpoint serves every
     * installation): typical busy repos burst ~5–10 events/s, and the
     * `pull_request.synchronize` events that now flow through (Bug 1
     * fix — no longer silenced) only add to the total. 600/min leaves
     * headroom for multi-org onboarding without per-installation tuning.
     */
    webhookMax: field(z.number().default(600), { env: "FIRST_TREE_RATE_LIMIT_WEBHOOK_MAX" }),
    /** Cap on Context Tree snapshot reads. */
    contextTreeSnapshotMax: field(z.number().default(6), {
      env: "FIRST_TREE_RATE_LIMIT_CONTEXT_TREE_SNAPSHOT_MAX",
    }),
    /**
     * Per-agent cap on outbound message writes (`POST /agent/chats/:chatId/messages`
     * and `POST /agent/agents/:name/messages`). Tighter than the global default
     * because automated agents are the common loop-failure mode.
     */
    agentMessageMax: field(z.number().default(30), { env: "FIRST_TREE_RATE_LIMIT_AGENT_MESSAGE_MAX" }),
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
     * shield. Tighten or loosen via `FIRST_TREE_WS_MAX_PAYLOAD` once we
     * have production P99 frame-size data.
     */
    maxPayload: field(z.number().int().min(1024).default(262_144), { env: "FIRST_TREE_WS_MAX_PAYLOAD" }),
  }),
  inbox: optional({
    /**
     * Backpressure cap on per-agent in-flight (un-acked) `inbox:deliver`
     * frames. Once reached the server stops pushing for that agent until an
     * ack arrives — leftover entries stay `pending` in the DB and get
     * replayed via the post-ack backlog scan. See proposal §3.5.
     *
     * The WS data plane is the only delivery path on this server build. The
     * legacy `new_message` doorbell + HTTP poll fallback was removed in
     * `first-tree@0.14.3`. Clients older than
     * 0.10.4 (before the WS push data plane was introduced) are no longer
     * supported; clients in 0.10.4 ~ 0.14.2 continue to work because they
     * read `server:welcome.capabilities.wsInboxDeliver` to skip their own
     * poll path on bootstrap.
     */
    maxInFlightPerAgent: field(z.number().int().min(1).max(1024).default(32), {
      env: "FIRST_TREE_INBOX_MAX_IN_FLIGHT_PER_AGENT",
    }),
  }),
  kael: optional({
    endpoint: field(z.string(), { env: "KAEL_ENDPOINT" }),
    apiKey: field(z.string(), { env: "KAEL_API_KEY", secret: true }),
    /** Public URL of this First Tree server, reachable from Kael for API callbacks */
    hubPublicUrl: field(z.string(), { env: "FIRST_TREE_PUBLIC_URL" }),
  }),
  feedback: optional({
    /**
     * GitHub repo where feedback issues are filed (owner/name).
     * HEARBACK_FEEDBACK_REPO is distinct from FIRST_TREE_GITHUB_* vars so
     * the feedback token can be scoped narrowly (issues:write on a single repo)
     * without widening First Tree's Context Tree access.
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
     * when First Tree sits behind a proxy you control (CDN, ingress). Otherwise
     * clients can spoof the header and bypass per-ip limits.
     */
    trustProxyHeaders: field(z.boolean().default(false), { env: "HEARBACK_TRUST_PROXY_HEADERS" }),
  }),
  observability: {
    logging: {
      level: field(logLevelSchema.default("info"), {
        env: "FIRST_TREE_LOG_LEVEL",
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
      endpoint: field(z.string(), { env: "FIRST_TREE_OTEL_ENDPOINT" }),
      /**
       * Exporter headers, serialized as `key1=value1,key2=value2` (one string — avoids
       * env-var record coercion issues). Secret because it typically holds the write token.
       */
      headers: field(z.string().default(""), { env: "FIRST_TREE_OTEL_HEADERS", secret: true }),
      exporter: field(z.enum(["otlp-http", "otlp-grpc"]).default("otlp-http")),
      serviceName: field(z.string().default("first-tree")),
      /**
       * Deployment environment label. Emitted as the OTel resource attribute
       * `deployment.environment.name` — trace backends (Logfire, Honeycomb, …)
       * use this to let one project span many environments while still
       * letting you filter by env in the UI.
       */
      environment: field(z.string().default("development"), {
        env: "FIRST_TREE_OTEL_ENVIRONMENT",
      }),
      sampleRate: field(z.number().min(0).max(1).default(1)),
      /**
       * Whether to attach `client.ip` to HTTP root spans. **Off by default**
       * because First Tree is open-source and IP addresses are personal data under
       * GDPR — defaulting to capture would force every self-hosted operator
       * to think about deletion / retention. Operators who need IP-level
       * audit (rate-limit forensics, login brute-force investigation, etc.)
       * can opt in via the env var.
       *
       * `user-agent`, `referer`, `request.id`, `user.id` etc. are still
       * captured unconditionally — those are not PII identifiers on their
       * own and have high day-to-day debug value.
       */
      captureClientIp: field(z.boolean().default(false), {
        env: "FIRST_TREE_OTEL_CAPTURE_CLIENT_IP",
      }),
    }),
  },
  /**
   * Command-package version advertisement. The server broadcasts a version
   * string to every Client via `server:welcome` so clients can detect drift
   * and self-update. We resolve the value at runtime by polling the npm
   * registry for the configured channel's `latest` dist-tag — decoupling
   * "what version clients should run" from the server's own build/deploy
   * cadence (otherwise prod auto-update silently stalls whenever the
   * server image lags behind a fresh CLI publish).
   *
   * Multi-env: each channel (prod / staging) ships as its own npm package
   * with its own `latest` dist-tag, so the per-channel selection happens
   * via the top-level `channel` field above — there is no separate
   * `update.channel` knob anymore. dev servers (channel=dev) skip the
   * poll entirely (no published package to poll).
   *
   * - `commandVersion`: bootstrap fallback used until the first successful
   *   poll, and the cache value when the registry is unreachable.
   *   Docker images inject `apps/cli/package.json.version` at build
   *   time via the `COMMAND_VERSION` build-arg.
   * - `pollIntervalMinutes`: refresh cadence. 60 minutes is the safe default
   *   for both prod (slow stable cadence) and staging (frequent publishes
   *   still get picked up within an hour). Tune lower on staging for
   *   tighter rollout.
   * - `registryUrl`: lets corp deployments point at a Verdaccio/Artifactory
   *   mirror with the same dist-tags.
   */
  update: {
    commandVersion: field(z.string().optional(), {
      env: "FIRST_TREE_COMMAND_VERSION",
    }),
    pollIntervalMinutes: field(z.coerce.number().int().min(1).max(1440).default(60), {
      env: "FIRST_TREE_UPDATE_POLL_INTERVAL_MINUTES",
    }),
    registryUrl: field(z.string().url().default("https://registry.npmjs.org"), {
      env: "FIRST_TREE_UPDATE_REGISTRY_URL",
    }),
  },
  /**
   * Runtime tunables. Replaced the deleted `/admin/system/config` HTTP
   * surface (proposal hub-strip-jwt-ambient-scope §3.5) — these knobs are
   * deployment-level, not customer-tunable, and get baked in via the
   * deploy manifest (systemd / docker-compose / Fly.toml / Render env).
   */
  runtime: {
    pollingIntervalSeconds: field(z.coerce.number().int().positive().default(5), {
      env: "FIRST_TREE_POLLING_INTERVAL_SECONDS",
    }),
    presenceCleanupSeconds: field(z.coerce.number().int().positive().default(60), {
      env: "FIRST_TREE_PRESENCE_CLEANUP_SECONDS",
    }),
    /**
     * Chat auto-archive sweeper cadence. Set to 0 to disable the sweeper
     * (useful in tests and one-off CLI runs). Default 300s (5 min) sits
     * comfortably below the smallest idle threshold (1h) so worst-case
     * archive latency is bounded by the threshold plus one tick.
     */
    archiveSweepIntervalSeconds: field(z.coerce.number().int().nonnegative().default(300), {
      env: "FIRST_TREE_ARCHIVE_SWEEP_INTERVAL_SECONDS",
    }),
    /**
     * Idle threshold for chats bound to GitHub PRs/Issues. Once every
     * bound entity is closed/merged AND the chat has been silent this
     * long, the sweeper flips every mapped human's view to `archived`.
     */
    archiveMappedIdleSeconds: field(
      z.coerce
        .number()
        .int()
        .positive()
        .default(60 * 60),
      {
        env: "FIRST_TREE_ARCHIVE_MAPPED_IDLE_SECONDS",
      },
    ),
    /**
     * Idle threshold for chats with no GitHub mapping and no human owner.
     * Per (chat, user) — users with unread mentions are skipped; users
     * without an unread stay archived after this much silence.
     */
    archiveUnmappedIdleSeconds: field(
      z.coerce
        .number()
        .int()
        .positive()
        .default(12 * 60 * 60),
      {
        env: "FIRST_TREE_ARCHIVE_UNMAPPED_IDLE_SECONDS",
      },
    ),
    /**
     * Optional outbound webhook URL — if set, every notification is
     * fire-and-forget POSTed here in JSON. Replaces the prior DB-backed
     * `notification_webhook_url` config row.
     */
    notificationWebhookUrl: field(z.string().url().optional(), {
      env: "FIRST_TREE_NOTIFICATION_WEBHOOK_URL",
    }),
  },
});

export type ServerConfig = InferConfig<typeof serverConfigSchema>;

/** Typed accessor for server configuration singleton. */
export function getServerConfig(): ServerConfig {
  return getConfig<ServerConfig>();
}
