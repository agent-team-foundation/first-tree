import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { DEFAULT_DATA_DIR } from "@agent-team-foundation/first-tree-hub-shared/config";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyBaseLogger } from "fastify";
import postgres from "postgres";
import { ZodError } from "zod";
import { adminAdapterMappingRoutes } from "./api/admin/adapter-mappings.js";
import { adminAdapterStatusRoutes } from "./api/admin/adapter-status.js";
import { adminAdapterRoutes } from "./api/admin/adapters.js";

import { adminAgentClientStatusRoutes } from "./api/admin/agent-client-status.js";
import { adminAgentConfigRoutes } from "./api/admin/agent-config.js";
import { adminAgentRoutes } from "./api/admin/agents.js";
import { adminChatRoutes } from "./api/admin/chats.js";
import { adminActivityRoutes, adminClientRoutes } from "./api/admin/clients.js";
import { adminNotificationRoutes } from "./api/admin/notifications.js";
import { adminOrganizationRoutes } from "./api/admin/organizations.js";
import { adminOverviewRoutes } from "./api/admin/overview.js";
import { adminSessionRoutes } from "./api/admin/sessions.js";
import { adminStatsRoutes } from "./api/admin/stats.js";
import { adminSystemConfigRoutes } from "./api/admin/system-config.js";
import { adminTaskRoutes } from "./api/admin/tasks.js";
import { adminWsRoutes } from "./api/admin/ws-admin.js";
import { agentChatRoutes } from "./api/agent/chats.js";
import { agentConfigRoutes } from "./api/agent/config.js";
import { agentFeishuBotRoutes } from "./api/agent/feishu-bot.js";
import { agentFeishuUserRoutes } from "./api/agent/feishu-user.js";
import { agentInboxRoutes } from "./api/agent/inbox.js";
import { agentMeRoutes } from "./api/agent/me.js";
import { agentMessageRoutes, agentSendToAgentRoutes } from "./api/agent/messages.js";
import { agentTaskRoutes } from "./api/agent/tasks.js";
import { clientWsRoutes } from "./api/agent/ws-client.js";
import { authRoutes } from "./api/auth.js";
import { authGithubRoutes } from "./api/auth-github.js";
import { bootstrapConfigRoutes } from "./api/bootstrap/config.js";
import { contextTreeInfoRoutes } from "./api/context-tree-info.js";
import { feedbackRoutes } from "./api/feedback.js";
import { healthRoutes } from "./api/health.js";
import { healthzRoutes } from "./api/healthz.js";
import { inviteRoutes } from "./api/invite.js";
import { meRoutes } from "./api/me.js";
import { meWorkspacesRoutes, switchOrgRoutes } from "./api/me-workspaces.js";
import { memberRoutes } from "./api/members.js";
// Public agent discovery removed — visibility is now handled via agent.visibility field
import { githubWebhookRoutes } from "./api/webhooks/github.js";
import type { Config } from "./config.js";
import { connectDatabase } from "./db/connection.js";
import { AppError } from "./errors.js";
import { agentSelectorHook } from "./middleware/agent-selector.js";
import { memberAuthHook, requireAdminRoleHook } from "./middleware/member-auth.js";
import { userAuthHook } from "./middleware/user-auth.js";
import {
  applyLoggerConfig,
  createLogger,
  currentTraceId,
  getFastifyOtelPlugin,
  observabilityPlugin,
  rootLogger,
} from "./observability/index.js";
import { type AdapterManager, createAdapterManager } from "./services/adapter-manager.js";
import { broadcastToAdmins } from "./services/admin-broadcast.js";
import { type BackgroundTasks, createBackgroundTasks } from "./services/background-tasks.js";
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

export async function buildApp(config: Config) {
  applyLoggerConfig({
    level: config.observability.logging.level,
    format: config.observability.logging.format,
    bridgeToSpanLevel: config.observability.logging.bridgeToSpanLevel,
  });

  // Cast widens pino.Logger<never, boolean> → FastifyBaseLogger so the
  // returned FastifyInstance has the default generic and remains assignable
  // in tests / callers that reference FastifyInstance without type args.
  const app = Fastify({ loggerInstance: rootLogger as unknown as FastifyBaseLogger });

  // Register @fastify/otel before any route — it wraps each request handler
  // in an HTTP span that becomes the parent for business spans.
  const otelPlugin = getFastifyOtelPlugin();
  if (otelPlugin) {
    await app.register(otelPlugin);
  }

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
  const listenClient = postgres(config.database.url, { max: 1 });
  const notifier = createNotifier(listenClient);

  // WebSocket plugin
  await app.register(websocket);

  // CORS — explicit origins if configured; allow all in dev; same-origin in production
  const corsOrigin = config.cors?.origin;
  const isDev = process.env.NODE_ENV !== "production";
  await app.register(cors, {
    origin: corsOrigin ? corsOrigin.split(",").map((s) => s.trim()) : isDev,
    credentials: true,
  });

  // Rate limiting — global default; overridden per-route where needed
  await app.register(rateLimit, {
    max: config.rateLimit?.max ?? 100,
    timeWindow: "1 minute",
  });

  // Auth hooks
  const memberAuth = memberAuthHook(db, config.secrets.jwtSecret);
  const userAuth = userAuthHook(db, config.secrets.jwtSecret);
  const adminOnly = requireAdminRoleHook();
  const agentSelector = agentSelectorHook(db);

  // Error handler — enriches error body with traceId so operators can search
  // the trace backend by `x-trace-id` or body.traceId.
  app.setErrorHandler((error, request, reply) => {
    const traceId = currentTraceId();
    const traceField = traceId ? { traceId } : {};
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({ error: error.message, ...traceField });
    }
    if (error instanceof ZodError) {
      return reply.status(400).send({ error: "Validation error", details: error.issues, ...traceField });
    }
    request.log.error({ err: error }, "unhandled request error");
    return reply.status(500).send({ error: "Internal server error", ...traceField });
  });

  // Root-level health check for container orchestration (outside /api/v1)
  await app.register(healthzRoutes);

  // All API routes under /api/v1 prefix
  await app.register(
    async (api) => {
      // Public routes
      await api.register(healthRoutes);
      await api.register(githubWebhookRoutes, { prefix: "/webhooks" });
      await api.register(authRoutes, { prefix: "/auth" });
      await api.register(authGithubRoutes, { prefix: "/auth/github" });
      await api.register(inviteRoutes, { prefix: "/invite" });
      await api.register(contextTreeInfoRoutes, { prefix: "/context-tree" });
      await api.register(bootstrapConfigRoutes, { prefix: "/bootstrap" });

      // User-token routes — accept both the rootless `type: "user"` JWT
      // (just signed in, no workspace) and the per-org `type: "access"`
      // JWT (existing user creating / joining another workspace).
      await api.register(
        async (userApp) => {
          userApp.addHook("onRequest", userAuth);
          await userApp.register(meWorkspacesRoutes);
        },
        { prefix: "/me/workspaces" },
      );
      await api.register(
        async (userApp) => {
          userApp.addHook("onRequest", userAuth);
          await userApp.register(switchOrgRoutes);
        },
        { prefix: "/auth" },
      );

      // Admin routes (JWT protected)
      await api.register(
        async (adminApp) => {
          adminApp.addHook("onRequest", memberAuth);
          await adminApp.register(adminAgentRoutes);
        },
        { prefix: "/admin/agents" },
      );

      // Step 2: per-agent runtime config.
      // Per-route guards in agent-config.ts enforce the real rule:
      //   GET    /:uuid/config          → assertAgentVisible (any visible viewer may read)
      //   PATCH  /:uuid/config          → assertCanManage   (manager or admin may edit)
      //   POST   /:uuid/config/dry-run  → assertCanManage   (manager or admin may preview)
      // This mirrors agents.managerId's documented "manager retains CRUD" semantics;
      // the previous plugin-scoped adminOnly hook short-circuited that, blocking
      // non-admin managers from editing behavior on agents they own.
      await api.register(
        async (adminApp) => {
          adminApp.addHook("onRequest", memberAuth);
          await adminApp.register(adminAgentConfigRoutes);
        },
        { prefix: "/admin/agents" },
      );

      // Step 10: per-agent client connectivity probe
      await api.register(
        async (adminApp) => {
          adminApp.addHook("onRequest", memberAuth);
          await adminApp.register(adminAgentClientStatusRoutes);
        },
        { prefix: "/admin/agents" },
      );

      await api.register(
        async (adminApp) => {
          adminApp.addHook("onRequest", memberAuth);
          adminApp.addHook("onRequest", adminOnly);
          await adminApp.register(adminSystemConfigRoutes);
        },
        { prefix: "/admin/system/config" },
      );

      await api.register(
        async (adminApp) => {
          adminApp.addHook("onRequest", memberAuth);
          await adminApp.register(adminOverviewRoutes);
        },
        { prefix: "/admin/overview" },
      );

      // Adapter bindings are scoped by role inside the handlers:
      //   - admin: all configs/mappings in the org
      //   - non-admin: only those bound to agents they manage
      // That lets the shared /settings page surface each user's own
      // bindings without an admin flag gating the entire route.
      await api.register(
        async (adminApp) => {
          adminApp.addHook("onRequest", memberAuth);
          await adminApp.register(adminAdapterRoutes);
        },
        { prefix: "/admin/adapters" },
      );

      await api.register(
        async (adminApp) => {
          adminApp.addHook("onRequest", memberAuth);
          await adminApp.register(adminAdapterMappingRoutes);
        },
        { prefix: "/admin/adapter-mappings" },
      );

      await api.register(
        async (adminApp) => {
          adminApp.addHook("onRequest", memberAuth);
          await adminApp.register(adminAdapterStatusRoutes);
        },
        { prefix: "/admin/adapters/status" },
      );

      await api.register(
        async (memberApp) => {
          memberApp.addHook("onRequest", memberAuth);
          await memberApp.register(memberRoutes);
        },
        { prefix: "/members" },
      );

      await api.register(
        async (memberApp) => {
          memberApp.addHook("onRequest", memberAuth);
          await memberApp.register(meRoutes);
        },
        { prefix: "" },
      );

      await api.register(
        async (adminApp) => {
          adminApp.addHook("onRequest", memberAuth);
          await adminApp.register(adminChatRoutes);
        },
        { prefix: "/admin/chats" },
      );

      // M1: Client management routes
      await api.register(
        async (adminApp) => {
          adminApp.addHook("onRequest", memberAuth);
          await adminApp.register(adminClientRoutes);
        },
        { prefix: "/clients" },
      );

      // M1: Agent activity routes
      await api.register(
        async (adminApp) => {
          adminApp.addHook("onRequest", memberAuth);
          await adminApp.register(adminActivityRoutes);
        },
        { prefix: "/admin/agents/activity" },
      );

      await api.register(
        async (adminApp) => {
          adminApp.addHook("onRequest", memberAuth);
          adminApp.addHook("onRequest", adminOnly);
          await adminApp.register(adminOrganizationRoutes);
        },
        { prefix: "/admin/organizations" },
      );

      await api.register(
        async (adminApp) => {
          adminApp.addHook("onRequest", memberAuth);
          adminApp.addHook("onRequest", adminOnly);
          await adminApp.register(adminStatsRoutes);
        },
        { prefix: "/admin/stats" },
      );

      await api.register(
        async (adminApp) => {
          adminApp.addHook("onRequest", memberAuth);
          await adminApp.register(adminTaskRoutes);
        },
        { prefix: "/admin/tasks" },
      );

      // M1: Session visibility routes
      await api.register(
        async (adminApp) => {
          adminApp.addHook("onRequest", memberAuth);
          await adminApp.register(adminSessionRoutes);
        },
        { prefix: "/admin/sessions" },
      );

      // M1: Notification routes
      await api.register(
        async (adminApp) => {
          adminApp.addHook("onRequest", memberAuth);
          await adminApp.register(adminNotificationRoutes);
        },
        { prefix: "/admin/notifications" },
      );

      // Agent routes (member JWT + X-Agent-Id selector; see middleware/agent-selector.ts)
      await api.register(
        async (agentApp) => {
          agentApp.addHook("onRequest", memberAuth);
          agentApp.addHook("onRequest", agentSelector);
          await agentApp.register(agentMeRoutes);
          await agentApp.register(agentChatRoutes, { prefix: "/chats" });
          await agentApp.register(agentMessageRoutes, { prefix: "/chats" });
          await agentApp.register(agentSendToAgentRoutes, { prefix: "/agents" });
          await agentApp.register(agentInboxRoutes, { prefix: "/inbox" });
          await agentApp.register(agentConfigRoutes);
          await agentApp.register(agentTaskRoutes, { prefix: "/tasks" });

          await agentApp.register(agentFeishuBotRoutes);
          await agentApp.register(agentFeishuUserRoutes, { prefix: "/delegated" });
        },
        { prefix: "/agent" },
      );

      // Client WebSocket — JWT auth via first-frame `auth` message, then
      // client:register + per-agent bind. Inbox notifications are fanned out
      // through this WS via the notifier.
      await api.register(clientWsRoutes(notifier, config.instanceId), { prefix: "/agent/ws" });

      // M1: Admin WebSocket (JWT auth via query param)
      await api.register(adminWsRoutes(notifier, config.secrets.jwtSecret), { prefix: "/ws" });
    },
    { prefix: "/api/v1" },
  );

  // Hearback feedback endpoint — mounted outside /api/v1 because the widget's
  // default `data-endpoint="/feedback"` expects `/feedback/chat`, `/feedback/submit`,
  // `/feedback/upload`, etc. Registered in an encapsulated scope so its
  // image/* content-type parser doesn't affect the rest of the app.
  if (config.feedback) {
    const feedbackConfig = config.feedback;
    await app.register(
      async (scope) => {
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
      },
      { prefix: "/feedback" },
    );
  }

  // Serve Web static files
  const webDistPath = config.webDistPath;
  if (webDistPath) {
    const webRoot = resolve(webDistPath);
    if (existsSync(webRoot)) {
      await app.register(fastifyStatic, { root: webRoot, wildcard: false });
      app.setNotFoundHandler((request, reply) => {
        if (request.url.startsWith("/api/")) {
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
