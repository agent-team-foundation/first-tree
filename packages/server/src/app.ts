import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, join, resolve } from "node:path";
import { DEFAULT_DATA_DIR } from "@agent-team-foundation/first-tree-hub-shared/config";
import { FIRST_TREE_HUB_ATTR, redactUrl } from "@agent-team-foundation/first-tree-hub-shared/observability";
import fastifyOpenTelemetry from "@autotelic/fastify-opentelemetry";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyPluginAsync } from "fastify";
import postgres from "postgres";
import { ZodError } from "zod";
import { adapterMappingRoutes } from "./api/adapter-mappings.js";
import { adapterRoutes } from "./api/adapters.js";
import { agentChatRoutes } from "./api/agent/chats.js";
import { agentConfigRoutes as agentRuntimeConfigRoutes } from "./api/agent/config.js";
import { agentFeishuBotRoutes } from "./api/agent/feishu-bot.js";
import { agentFeishuUserRoutes } from "./api/agent/feishu-user.js";
import { agentInboxRoutes } from "./api/agent/inbox.js";
import { agentMeRoutes } from "./api/agent/me.js";
import { agentMessageRoutes, agentSendToAgentRoutes } from "./api/agent/messages.js";
import { clientWsRoutes } from "./api/agent/ws-client.js";
import { agentActivityRoutes } from "./api/agent-activity.js";
import { agentRoutes } from "./api/agents.js";
import { agentConfigRoutes } from "./api/agents-config.js";
import { githubOauthRoutes } from "./api/auth/github.js";
import { authRoutes } from "./api/auth.js";
import { bootstrapConfigRoutes } from "./api/bootstrap/config.js";
import { chatRoutes } from "./api/chats.js";
import { clientRoutes } from "./api/clients.js";
import { contextTreeInfoRoutes } from "./api/context-tree-info.js";
import { contextTreeSnapshotRoutes } from "./api/context-tree-snapshot.js";
import { feedbackRoutes } from "./api/feedback.js";
import { healthRoutes } from "./api/health.js";
import { healthzRoutes } from "./api/healthz.js";
import { publicInvitationRoutes } from "./api/invitations.js";
import { meRoutes } from "./api/me.js";
import { orgActivityRoutes } from "./api/orgs/activity.js";
import { orgAdapterMappingRoutes } from "./api/orgs/adapter-mappings.js";
import { orgAdapterStatusRoutes } from "./api/orgs/adapter-status.js";
import { orgAdapterRoutes } from "./api/orgs/adapters.js";
import { orgAgentRoutes } from "./api/orgs/agents.js";
import { orgChatRoutes } from "./api/orgs/chats.js";
import { orgClientRoutes } from "./api/orgs/clients.js";
import { orgContextTreeSnapshotRoutes } from "./api/orgs/context-tree-snapshot.js";
import { orgGithubAppRoutes } from "./api/orgs/github-app.js";
import { orgIdentityRoutes } from "./api/orgs/identity.js";
import { orgInvitationRoutes } from "./api/orgs/invitations.js";
import { orgMemberRoutes } from "./api/orgs/members.js";
import { orgNotificationRoutes } from "./api/orgs/notifications.js";
import { orgOverviewRoutes } from "./api/orgs/overview.js";
import { orgSessionRoutes } from "./api/orgs/sessions.js";
import { orgSettingsRoutes } from "./api/orgs/settings.js";
import { orgWsRoutes } from "./api/orgs/ws.js";
import { sessionRoutes } from "./api/sessions.js";
import { githubWebhookRoutes } from "./api/webhooks/github.js";
// Public agent discovery removed — visibility is now handled via agent.visibility field
import { githubAppWebhookRoutes } from "./api/webhooks/github-app.js";
import { assertBootConfigValid } from "./boot-guards.js";
import type { Config } from "./config.js";
import { connectDatabase, sslOptions } from "./db/connection.js";
import { AppError } from "./errors.js";
import { agentSelectorHook } from "./middleware/agent-selector.js";
import { userAuthHook } from "./middleware/user-auth.js";
import {
  applyLoggerConfig,
  attachRequestContext,
  bodyCaptureOnSendHook,
  buildRateLimitError,
  createLogger,
  currentTraceId,
  observabilityPlugin,
  reportErrorToRoot,
  rootLogger,
} from "./observability/index.js";
import { type AdapterManager, createAdapterManager } from "./services/adapter-manager.js";
import { broadcastToAdmins } from "./services/admin-broadcast.js";
import { expiryToSeconds } from "./services/auth.js";
import { type BackgroundTasks, createBackgroundTasks } from "./services/background-tasks.js";
import { registerChatMessageDispatcher } from "./services/chat-projection.js";
import { createConfigService } from "./services/config-service.js";
import { createKaelRuntime, type KaelRuntime } from "./services/kael-runtime.js";
import { createNotifier, type Notifier } from "./services/notifier.js";
import { ensureDefaultOrganization } from "./services/organization.js";
import { createPulseAggregator } from "./services/pulse-aggregator.js";

// Fastify type augmentation
import "./types.js";

export type AppContext = {
  notifier: Notifier;
  backgroundTasks: BackgroundTasks;
  adapterManager: AdapterManager;
  kaelRuntime: KaelRuntime | undefined;
};

/**
 * Resolve the Command-package version advertised to clients. Prefers the
 * value the Command CLI explicitly injected; otherwise falls back to the
 * server workspace's own package.json (dev mode, `pnpm --filter … dev`).
 * Returning a string (rather than undefined) keeps the welcome frame well-
 * formed — the client treats the value advisorily.
 */
function resolveCommandVersion(injected: string | undefined): string {
  if (injected && injected.trim().length > 0) return injected;
  try {
    const req = createRequire(import.meta.url);
    const pkg = req("../package.json") as { version?: string };
    if (typeof pkg.version === "string" && pkg.version.length > 0) return pkg.version;
  } catch {
    // fall through
  }
  return "0.0.0";
}

/**
 * Stamp `fn.name` so fastify's `getPluginName()` and `@fastify/otel` use the
 * label we want — keeps hook spans rendering as `handler - adminAgentScope`
 * instead of `handler - async (app) => { -- const jwtSecre…` (the
 * `getFuncPreview()` fallback fastify uses for anonymous plugin functions).
 */
function namePlugin<T extends FastifyPluginAsync>(name: string, fn: T): T {
  Object.defineProperty(fn, "name", { value: name, configurable: true });
  return fn;
}

export async function buildApp(config: Config) {
  // Validate token-lifetime config eagerly so a typo in
  // `FIRST_TREE_HUB_AUTH_*_EXPIRY` fails the boot, not the first
  // /connect-tokens call hours later. Both server entry points
  // (the standalone bin and the CLI's `server start`) flow through
  // buildApp, so this single check covers both.
  try {
    expiryToSeconds(config.auth.accessTokenExpiry);
    expiryToSeconds(config.auth.refreshTokenExpiry);
    expiryToSeconds(config.auth.connectTokenExpiry);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${msg} — check FIRST_TREE_HUB_AUTH_*_EXPIRY env vars (got access=${config.auth.accessTokenExpiry}, refresh=${config.auth.refreshTokenExpiry}, connect=${config.auth.connectTokenExpiry}).`,
    );
  }

  // GitHub App config sanity (PEM header / blank-secret / half-config).
  // Runs here so a misconfigured App env block fails the boot, not the
  // first App JWT call hours later. Both server entry points (standalone
  // bin and CLI `server start`) flow through buildApp, so this single
  // check covers both — cheap, only fires when the App block is present.
  assertBootConfigValid(config);

  applyLoggerConfig({
    level: config.observability.logging.level,
    format: config.observability.logging.format,
    bridgeToSpanLevel: config.observability.logging.bridgeToSpanLevel,
  });

  // Cast widens pino.Logger<never, boolean> → FastifyBaseLogger so the
  // returned FastifyInstance has the default generic and remains assignable
  // in tests / callers that reference FastifyInstance without type args.
  const app = Fastify({
    loggerInstance: rootLogger as unknown as FastifyBaseLogger,
    // When deployed behind Cloudflare / reverse proxy, `req.ip` must reflect
    // the real client IP rather than the proxy — otherwise every IP-keyed
    // rate-limit key collapses. Operators set FIRST_TREE_HUB_TRUST_PROXY=true
    // when they control the upstream proxy chain.
    trustProxy: config.trustProxy,
  });

  // Loud security reminder: trustProxy=true makes Fastify trust ANY upstream's
  // x-forwarded-for header. Safe iff the Hub container only receives traffic
  // through a vetted proxy (Cloudflare → CapRover). If the container is ever
  // exposed to the public internet directly, attackers can spoof XFF and
  // bypass every IP-keyed rate limit / audit log. Surface this on every boot
  // so a misconfiguration is loud rather than silent.
  if (config.trustProxy) {
    app.log.warn(
      "trustProxy=true — Fastify trusts ANY upstream's x-forwarded-for. " +
        "Ensure Cloudflare / CapRover is the only ingress; do NOT expose this " +
        "container's port to the public internet directly.",
    );
  }

  // HTTP tracing — `@autotelic/fastify-opentelemetry` opens one span on
  // `onRequest`, ends it on `onResponse`. No per-hook child spans (so we
  // never see `handler - async (app) => …` noise), and the span is exposed
  // via `request.openTelemetry().activeSpan` so any later hook / handler
  // can decorate it without `trace.getActiveSpan()` foot-guns.
  //
  // Logfire's bundled `@opentelemetry/instrumentation-fastify` is disabled
  // in `logfire-init.ts` to avoid duplicate root spans.
  //
  // `formatSpanAttributes` overrides autotelic's defaults to:
  //   - align attribute names with OTel HTTP semantic conventions
  //     (`http.method`, `http.url`, `http.response.status_code`,
  //     `exception.type`, `exception.message`, `exception.stacktrace`)
  //     so dashboards / saved queries port between trace backends
  //   - capture `user-agent`, `referer`, `request.id` unconditionally
  //     (no PII, high day-to-day debug value)
  //   - capture `client.ip` only when `captureClientIp` is enabled — the
  //     opt-in honours the GDPR-friendly default discussed in the
  //     observability overhaul. See server-config.ts for the env switch.
  const captureClientIp = config.observability.tracing?.captureClientIp ?? false;
  await app.register(fastifyOpenTelemetry, {
    wrapRoutes: true,
    formatSpanName: (request) => {
      const route = request.routeOptions?.url;
      const method = request.method ?? "GET";
      if (route) return `${method} ${route}`;
      const pathOnly = request.url.split("?")[0] ?? request.url;
      return `${method} ${pathOnly}`;
    },
    formatSpanAttributes: {
      request: (request) => {
        const route = request.routeOptions?.url;
        const target = request.url.split("?")[0] ?? request.url;
        // `http.url` retains the query string for debugability but is run
        // through `redactUrl` so JWTs in `?token=…` (admin WS upgrade) never
        // reach the trace exporter — same vocabulary as the fastify logger's
        // `req` serializer, see `observability/logger.ts`.
        const attrs: Record<string, string | number | boolean> = {
          "http.method": request.method,
          "http.url": redactUrl(request.url),
          "http.target": target,
          "http.scheme": request.protocol,
          "http.host": String(request.headers.host ?? ""),
          "request.id": request.id,
        };
        if (route) attrs["http.route"] = route;
        const ua = request.headers["user-agent"];
        if (typeof ua === "string" && ua.length > 0) {
          attrs["http.user_agent"] = ua.slice(0, 200);
        }
        const referer = request.headers.referer ?? request.headers.referrer;
        if (typeof referer === "string" && referer.length > 0) {
          attrs["http.referer"] = referer.slice(0, 200);
        }
        if (captureClientIp) {
          attrs["client.ip"] = request.ip;
        }
        return attrs;
      },
      reply: (reply) => ({
        "http.status_code": reply.statusCode,
        "http.response.status_code": reply.statusCode,
      }),
      error: (error) => ({
        "exception.type": error.name,
        "exception.message": error.message,
        "exception.stacktrace": error.stack ?? "",
      }),
    },
    // Skip tracing for:
    //   - static SPA assets, fonts, healthchecks → volume without value
    //   - hearback feedback widget endpoints → outside the API surface
    //   - WebSocket upgrade routes → fastify hijacks the reply, so an HTTP
    //     root span here would never see `onResponse` and would leak.
    //     We emit a dedicated long-running `ws.connection` span from
    //     `ws-tracing.ts` instead.
    ignoreRoutes: (path: string) => {
      if (path === "/" || path === "/healthz") return true;
      if (path.startsWith("/assets/") || path.startsWith("/fonts/")) return true;
      if (path.startsWith("/feedback/")) return true;
      if (path === "/api/v1/agent/ws/client") return true;
      // Org WS upgrade: `/api/v1/orgs/:orgId/ws/`. Use a startsWith check so
      // every org's socket-upgrade path is excluded.
      if (path.startsWith("/api/v1/orgs/") && path.endsWith("/ws/")) return true;
      return false;
    },
  });

  // Request-scoped logger + x-trace-id + error correlation
  await app.register(observabilityPlugin);

  // Decorate with config and db
  const db = connectDatabase(config.database.url);
  app.decorate("db", db);
  app.decorate("config", config);

  // Advisory Command-package version broadcast to every Client via the
  // `server:welcome` WS frame — lets clients detect version drift.
  const commandVersion = resolveCommandVersion(config.commandVersion);
  app.decorate("commandVersion", commandVersion);
  app.log.info({ commandVersion }, "Hub server advertising command version");

  // Notifier: dedicated PG connection for LISTEN/NOTIFY
  const listenClient = postgres(config.database.url, { max: 1, ...sslOptions(config.database.url) });
  const notifier = createNotifier(listenClient);

  // WebSocket plugin. `maxPayload` caps a single inbound frame so a hostile
  // or buggy client cannot OOM the server with one giant message. Frames in
  // this codebase are JSON envelopes; image content travels via HTTP.
  await app.register(websocket, {
    options: { maxPayload: config.ws?.maxPayload ?? 65_536 },
  });

  // CORS — explicit origins if configured; allow all in dev; same-origin in production
  const corsOrigin = config.cors?.origin;
  const isDev = process.env.NODE_ENV !== "production";
  await app.register(cors, {
    origin: corsOrigin ? corsOrigin.split(",").map((s) => s.trim()) : isDev,
    credentials: true,
  });

  // Rate limiting — global default; overridden per-route where needed.
  // `hook: "preHandler"` runs the limiter after route-level onRequest hooks
  // (memberAuth, agentSelector) so per-route keyGenerators can read
  // `req.user` / `req.agent` populated by those hooks.
  //
  // `errorResponseBuilder` runs during the rate-limit throw path, before
  // setErrorHandler enriches with traceId. The body of the builder lives
  // in observability/rate-limit-error-builder.ts so the span-stamping
  // side effect can be unit-tested without booting an app.
  await app.register(rateLimit, {
    max: config.rateLimit?.max ?? 100,
    timeWindow: "1 minute",
    hook: "preHandler",
    errorResponseBuilder: buildRateLimitError,
  });

  // Body-capture onSend hook — opt-in per route via `config: { otelRecordBody: true }`
  // and only fires on `statusCode >= 400`. Registered globally so any route
  // that flips the flag participates without extra wiring.
  app.addHook("onSend", bodyCaptureOnSendHook);

  // Auth hooks
  const userAuth = userAuthHook(db, config.secrets.jwtSecret);
  const agentSelector = agentSelectorHook(db);

  // Helper: build a user-authenticated plugin scope. Each scope mounts:
  //   1. userAuth (validate JWT, populate request.user = { userId })
  //   2. attachRequestContext (stamp user.id onto root span)
  //   3. The caller-provided routes
  //
  // Per-org and per-resource gating is handled INSIDE handlers via the
  // `scope/require-*` helpers (`requireOrgMembership`, `requireAgentAccess`,
  // …) — NOT at the plugin scope level. This is what kills the JWT-ambient-
  // scope bug class: the URL carries the scope explicitly and the helpers
  // probe membership in real time.
  function userScope(name: string, register: (scope: FastifyInstance) => Promise<void>): FastifyPluginAsync {
    return namePlugin(name, async (scope) => {
      scope.addHook("onRequest", userAuth);
      scope.addHook("onRequest", attachRequestContext);
      await register(scope);
    });
  }

  function agentScope(name: string, register: (scope: FastifyInstance) => Promise<void>): FastifyPluginAsync {
    return namePlugin(name, async (scope) => {
      scope.addHook("onRequest", userAuth);
      scope.addHook("onRequest", agentSelector);
      scope.addHook("onRequest", attachRequestContext);
      await register(scope);
    });
  }

  // Error handler — enriches error body with traceId so operators can search
  // the trace backend by `x-trace-id` or body.traceId, AND stamps the active
  // span with structured failure attributes via reportError. The latter
  // matters for 4xx responses too: @fastify/otel marks any response with
  // status < 500 as `SpanStatusCode.OK` in its onSend hook, so we record
  // the exception explicitly here to keep the failure visible in trace
  // backends without needing to query SpanStatus.
  app.setErrorHandler((error, request, reply) => {
    const traceId = currentTraceId();
    const traceField = traceId ? { traceId } : {};

    if (error instanceof AppError) {
      // Caller-supplied attrs spread FIRST so the canonical `error.type` /
      // `http.status_code` always win — `AppError.attrs` is a public field
      // and we don't want a future caller to accidentally clobber the
      // structural fields by passing them with the same key.
      reportErrorToRoot(request, error.message, error, {
        ...(error.attrs ?? {}),
        [FIRST_TREE_HUB_ATTR.ERROR_TYPE]: error.name,
        "http.status_code": error.statusCode,
      });
      return reply.status(error.statusCode).send({ error: error.message, ...traceField });
    }

    if (error instanceof ZodError) {
      reportErrorToRoot(request, "Validation error", error, {
        [FIRST_TREE_HUB_ATTR.ERROR_TYPE]: "ZodError",
        "validation.issue_count": error.issues.length,
      });
      return reply.status(400).send({ error: "Validation error", details: error.issues, ...traceField });
    }

    // Fastify plugins (e.g. @fastify/rate-limit's 429, @fastify/jwt's 401)
    // throw errors with `statusCode` in the 4xx range. Surface them with
    // their intended status + message rather than collapsing to 500. 5xx
    // statuses still fall through to the generic handler below to avoid
    // leaking server-internal messages.
    if (
      error instanceof Error &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    ) {
      reportErrorToRoot(request, error.message, error, {
        [FIRST_TREE_HUB_ATTR.ERROR_TYPE]: error.name,
        "http.status_code": error.statusCode,
      });
      return reply.status(error.statusCode).send({ error: error.message, ...traceField });
    }

    request.log.error({ err: error }, "unhandled request error");
    reportErrorToRoot(request, "Internal server error", error, {
      [FIRST_TREE_HUB_ATTR.ERROR_TYPE]: error instanceof Error ? error.name : "UnknownError",
      "http.status_code": 500,
    });
    return reply.status(500).send({ error: "Internal server error", ...traceField });
  });

  // Root-level health check for container orchestration (outside /api/v1)
  await app.register(healthzRoutes);

  // All API routes under /api/v1 prefix
  await app.register(
    namePlugin("apiV1Scope", async (api) => {
      // ── Public routes ────────────────────────────────────────────────────
      await api.register(healthRoutes);
      await api.register(githubWebhookRoutes, { prefix: "/webhooks" });
      await api.register(githubAppWebhookRoutes, { prefix: "/webhooks" });
      await api.register(authRoutes, { prefix: "/auth" });
      await api.register(githubOauthRoutes, { prefix: "/auth/github" });
      await api.register(publicInvitationRoutes, { prefix: "/invitations" });
      await api.register(bootstrapConfigRoutes, { prefix: "/bootstrap" });

      // ── Class A — `/me`, `/auth` (user-scoped) ──────────────────────────
      await api.register(
        userScope("contextTreeScope", async (scope) => {
          await scope.register(contextTreeInfoRoutes);
          await scope.register(contextTreeSnapshotRoutes);
        }),
        { prefix: "/context-tree" },
      );

      await api.register(
        userScope("meRoutesScope", async (scope) => {
          await scope.register(meRoutes);
        }),
        { prefix: "" },
      );

      // ── Class B — `/orgs/:orgId/...` (org-scoped) ───────────────────────
      await api.register(
        userScope("orgsScope", async (scope) => {
          await scope.register(orgIdentityRoutes);
          await scope.register(orgAgentRoutes, { prefix: "/agents" });
          await scope.register(orgChatRoutes, { prefix: "/chats" });
          await scope.register(orgAdapterRoutes, { prefix: "/adapters" });
          await scope.register(orgAdapterMappingRoutes, { prefix: "/adapter-mappings" });
          await scope.register(orgAdapterStatusRoutes, { prefix: "/adapters/status" });
          await scope.register(orgOverviewRoutes, { prefix: "/overview" });
          await scope.register(orgActivityRoutes, { prefix: "/activity" });
          await scope.register(orgSessionRoutes, { prefix: "/sessions" });
          await scope.register(orgNotificationRoutes, { prefix: "/notifications" });
          await scope.register(orgClientRoutes, { prefix: "/clients" });
          await scope.register(orgInvitationRoutes, { prefix: "/invitations" });
          await scope.register(orgMemberRoutes, { prefix: "/members" });
          await scope.register(orgSettingsRoutes, { prefix: "/settings" });
          await scope.register(orgGithubAppRoutes, { prefix: "/github-app-installation" });
          await scope.register(orgContextTreeSnapshotRoutes, { prefix: "/context-tree" });
        }),
        { prefix: "/orgs/:orgId" },
      );

      // ── Class B — Admin WS (mounted separately because of the websocket plugin scope) ─
      await api.register(orgWsRoutes(notifier, config.secrets.jwtSecret), { prefix: "/orgs/:orgId/ws" });

      // ── Class C — resource-scoped (`/agents/:uuid`, `/chats/:chatId`, …) ─
      await api.register(
        userScope("resourcesScope", async (scope) => {
          await scope.register(agentRoutes, { prefix: "/agents" });
          await scope.register(agentConfigRoutes, { prefix: "/agents" });
          await scope.register(agentActivityRoutes, { prefix: "/agents" });
          await scope.register(sessionRoutes, { prefix: "/agents" });
          await scope.register(chatRoutes, { prefix: "/chats" });
          await scope.register(adapterRoutes, { prefix: "/adapters" });
          await scope.register(adapterMappingRoutes, { prefix: "/adapter-mappings" });
          await scope.register(clientRoutes, { prefix: "/clients" });
        }),
        { prefix: "" },
      );

      // ── Class D — agent runtime self ────────────────────────────────────
      await api.register(
        agentScope("agentRuntimeScope", async (scope) => {
          await scope.register(agentMeRoutes);
          await scope.register(agentChatRoutes, { prefix: "/chats" });
          await scope.register(agentMessageRoutes, { prefix: "/chats" });
          await scope.register(agentSendToAgentRoutes, { prefix: "/agents" });
          await scope.register(agentInboxRoutes, { prefix: "/inbox" });
          await scope.register(agentRuntimeConfigRoutes);

          await scope.register(agentFeishuBotRoutes);
          await scope.register(agentFeishuUserRoutes, { prefix: "/delegated" });
        }),
        { prefix: "/agent" },
      );

      // Client WebSocket (Class D) — JWT first-frame `auth`, then
      // client:register + per-agent bind. Inbox notifications fan out here.
      await api.register(clientWsRoutes(notifier, config.instanceId), { prefix: "/agent/ws" });
    }),
    { prefix: "/api/v1" },
  );

  // Hearback feedback endpoint — mounted outside /api/v1 because the widget's
  // default `data-endpoint="/feedback"` expects `/feedback/chat`, `/feedback/submit`,
  // `/feedback/upload`, etc. Registered in an encapsulated scope so its
  // image/* content-type parser doesn't affect the rest of the app.
  if (config.feedback) {
    const feedbackConfig = config.feedback;
    await app.register(
      namePlugin("feedbackScope", async (scope) => {
        await scope.register(feedbackRoutes, {
          repo: feedbackConfig.repo,
          githubToken: feedbackConfig.githubToken,
          llm: feedbackConfig.llm
            ? {
                apiKey: feedbackConfig.llm.apiKey,
                baseUrl: feedbackConfig.llm.baseUrl,
                model: feedbackConfig.llm.model,
              }
            : undefined,
          trustProxyHeaders: feedbackConfig.trustProxyHeaders,
        });
      }),
      { prefix: "/feedback" },
    );
  }

  // Serve Web static files
  const webDistPath = config.webDistPath;
  if (webDistPath) {
    const webRoot = resolve(webDistPath);
    if (existsSync(webRoot)) {
      await app.register(fastifyStatic, { root: webRoot });
      app.setNotFoundHandler((request, reply) => {
        if (request.url.startsWith("/api/")) {
          return reply.status(404).send({ error: "Not found" });
        }
        const requestPath = request.url.split("?")[0] ?? request.url;
        if (requestPath.startsWith("/assets/") || extname(requestPath).length > 0) {
          return reply.status(404).send({ error: "Not found" });
        }
        // SPA fallback: serve index.html for non-API routes
        return reply.sendFile("index.html");
      });
    }
  }

  // Decorate notifier so routes can trigger PG NOTIFY
  app.decorate("notifier", notifier);

  // Per-agent runtime config service (Step 2)
  const configService = createConfigService({
    db,
    notifier,
    encryptionKey: config.secrets.encryptionKey,
  });
  app.decorate("configService", configService);

  // Adapter manager — decorated so admin routes can trigger reload
  const adapterManager = createAdapterManager(db, config.secrets.encryptionKey, app.log, notifier);
  app.decorate("adapterManager", adapterManager);

  // Kael runtime — server-embedded forwarding to Kael API
  const contextTreeDir = join(DEFAULT_DATA_DIR, "context-tree");
  const kaelRuntime = config.kael?.endpoint
    ? createKaelRuntime(
        db,
        config.secrets.encryptionKey,
        config.kael.endpoint,
        config.kael.apiKey,
        config.kael.hubPublicUrl,
        app.log,
        contextTreeDir,
      )
    : undefined;

  // Background tasks
  const backgroundTasks = createBackgroundTasks(app, config.instanceId, adapterManager, kaelRuntime);

  // NC1 pulse aggregator — 32-bucket rolling window over runtime state
  // transitions. Broadcasts a per-org `pulse:tick` frame every 5s to admin
  // sockets. Lifecycle aligned with backgroundTasks via the onReady/onClose
  // hooks below.
  const pulseAggregator = createPulseAggregator({ notifier, broadcast: broadcastToAdmins });

  // Register config change handler for hot reload
  const hotReloadLog = createLogger("HotReload");
  notifier.onConfigChange((configType) => {
    if (configType === "adapter_configs") {
      adapterManager.reload().catch((err) => hotReloadLog.error({ err }, "adapter hot-reload failed (PG NOTIFY)"));
      kaelRuntime?.reload().catch((err) => hotReloadLog.error({ err }, "kael hot-reload failed (PG NOTIFY)"));
    }
  });

  // Chat-first workspace cross-process kick. The message hot path calls
  // `fireChatMessageKick(chatId, messageId)` after each tx commits; we
  // forward that to the live notifier so it ends up on the
  // `chat_message_events` channel.
  registerChatMessageDispatcher((chatId, messageId) => {
    notifier
      .notifyChatMessage(chatId, messageId)
      .catch((err) => createLogger("chat-message-kick").warn({ err, chatId, messageId }, "chat:message kick failed"));
  });

  // Start notifier and background tasks on server start
  app.addHook("onReady", async () => {
    // Ensure the default organization exists (idempotent)
    await ensureDefaultOrganization(db);
    await notifier.start();
    backgroundTasks.start();
    pulseAggregator.start();
    await adapterManager.reload();
    await kaelRuntime?.reload();
  });

  // Cleanup on close
  app.addHook("onClose", async () => {
    pulseAggregator.stop();
    backgroundTasks.stop();
    adapterManager.shutdown();
    kaelRuntime?.shutdown();
    await notifier.stop();
    await listenClient.end();
    await db.end();
  });

  return app;
}
