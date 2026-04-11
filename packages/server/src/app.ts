import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_DATA_DIR } from "@agent-team-foundation/first-tree-hub-shared/config";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import postgres from "postgres";
import { ZodError } from "zod";
import { adminAdapterMappingRoutes } from "./api/admin/adapter-mappings.js";
import { adminAdapterStatusRoutes } from "./api/admin/adapter-status.js";
import { adminAdapterRoutes } from "./api/admin/adapters.js";

import { adminAgentRoutes } from "./api/admin/agents.js";
import { adminAuthRoutes } from "./api/admin/auth.js";
import { adminChatRoutes } from "./api/admin/chats.js";
import { adminActivityRoutes, adminClientRoutes } from "./api/admin/clients.js";
import { adminOrganizationRoutes } from "./api/admin/organizations.js";
import { adminOverviewRoutes } from "./api/admin/overview.js";
import { adminStatsRoutes } from "./api/admin/stats.js";
import { adminSystemConfigRoutes } from "./api/admin/system-config.js";
import { adminTaskRoutes } from "./api/admin/tasks.js";
import { adminUserRoutes } from "./api/admin/users.js";
import { agentChatRoutes } from "./api/agent/chats.js";

import { agentFeishuBotRoutes } from "./api/agent/feishu-bot.js";
import { agentFeishuUserRoutes } from "./api/agent/feishu-user.js";
import { agentInboxRoutes } from "./api/agent/inbox.js";
import { agentMeRoutes } from "./api/agent/me.js";
import { agentMessageRoutes, agentSendToAgentRoutes } from "./api/agent/messages.js";
import { agentTaskRoutes } from "./api/agent/tasks.js";
import { agentWsRoutes } from "./api/agent/ws.js";
import { clientWsRoutes } from "./api/agent/ws-client.js";
import { bootstrapConfigRoutes } from "./api/bootstrap/config.js";
import { bootstrapRoutes } from "./api/bootstrap/token.js";
import { contextTreeInfoRoutes } from "./api/context-tree-info.js";
import { healthRoutes } from "./api/health.js";
import { healthzRoutes } from "./api/healthz.js";
import { publicAgentRoutes } from "./api/public/agents.js";
import { githubWebhookRoutes } from "./api/webhooks/github.js";
import type { Config } from "./config.js";
import { connectDatabase } from "./db/connection.js";
import { AppError } from "./errors.js";
import { adminAuthHook } from "./middleware/admin-auth.js";
import { agentAuthHook } from "./middleware/agent-auth.js";
import { githubAuthHook } from "./middleware/github-auth.js";
import { type AdapterManager, createAdapterManager } from "./services/adapter-manager.js";
import { type BackgroundTasks, createBackgroundTasks } from "./services/background-tasks.js";
import { createKaelRuntime, type KaelRuntime } from "./services/kael-runtime.js";
import { createNotifier, type Notifier } from "./services/notifier.js";
import { ensureDefaultOrganization } from "./services/organization.js";

// Fastify type augmentation
import "./types.js";

export type AppContext = {
  notifier: Notifier;
  backgroundTasks: BackgroundTasks;
  adapterManager: AdapterManager;
  kaelRuntime: KaelRuntime | undefined;
};

export async function buildApp(config: Config) {
  const app = Fastify({ logger: config.logger ?? true });

  // Decorate with config and db
  const db = connectDatabase(config.database.url);
  app.decorate("db", db);
  app.decorate("config", config);

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
  const agentAuth = agentAuthHook(db);
  const adminAuth = adminAuthHook(db, config.secrets.jwtSecret);
  const githubAuth = githubAuthHook();

  // Error handler
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({ error: error.message });
    }
    if (error instanceof ZodError) {
      return reply.status(400).send({ error: "Validation error", details: error.issues });
    }
    app.log.error(error);
    return reply.status(500).send({ error: "Internal server error" });
  });

  // Root-level health check for container orchestration (outside /api/v1)
  await app.register(healthzRoutes);

  // All API routes under /api/v1 prefix
  await app.register(
    async (api) => {
      // Public routes
      await api.register(healthRoutes);
      await api.register(githubWebhookRoutes, { prefix: "/webhooks" });
      await api.register(adminAuthRoutes, { prefix: "/admin/auth" });
      await api.register(contextTreeInfoRoutes, { prefix: "/context-tree" });
      await api.register(bootstrapConfigRoutes, { prefix: "/bootstrap" });

      // Bootstrap routes (GitHub token protected)
      await api.register(
        async (bootstrapApp) => {
          bootstrapApp.addHook("onRequest", githubAuth);
          await bootstrapApp.register(bootstrapRoutes);
        },
        { prefix: "/bootstrap" },
      );

      // Admin routes (JWT protected)
      await api.register(
        async (adminApp) => {
          adminApp.addHook("onRequest", adminAuth);
          await adminApp.register(adminAgentRoutes);
        },
        { prefix: "/admin/agents" },
      );

      await api.register(
        async (adminApp) => {
          adminApp.addHook("onRequest", adminAuth);
          await adminApp.register(adminSystemConfigRoutes);
        },
        { prefix: "/admin/system/config" },
      );

      await api.register(
        async (adminApp) => {
          adminApp.addHook("onRequest", adminAuth);
          await adminApp.register(adminOverviewRoutes);
        },
        { prefix: "/admin/overview" },
      );

      await api.register(
        async (adminApp) => {
          adminApp.addHook("onRequest", adminAuth);
          await adminApp.register(adminAdapterRoutes);
        },
        { prefix: "/admin/adapters" },
      );

      await api.register(
        async (adminApp) => {
          adminApp.addHook("onRequest", adminAuth);
          await adminApp.register(adminAdapterMappingRoutes);
        },
        { prefix: "/admin/adapter-mappings" },
      );

      await api.register(
        async (adminApp) => {
          adminApp.addHook("onRequest", adminAuth);
          await adminApp.register(adminAdapterStatusRoutes);
        },
        { prefix: "/admin/adapters/status" },
      );

      await api.register(
        async (adminApp) => {
          adminApp.addHook("onRequest", adminAuth);
          await adminApp.register(adminUserRoutes);
        },
        { prefix: "/admin/users" },
      );

      await api.register(
        async (adminApp) => {
          adminApp.addHook("onRequest", adminAuth);
          await adminApp.register(adminChatRoutes);
        },
        { prefix: "/admin/chats" },
      );

      // M1: Client management routes
      await api.register(
        async (adminApp) => {
          adminApp.addHook("onRequest", adminAuth);
          await adminApp.register(adminClientRoutes);
        },
        { prefix: "/admin/clients" },
      );

      // M1: Agent activity routes
      await api.register(
        async (adminApp) => {
          adminApp.addHook("onRequest", adminAuth);
          await adminApp.register(adminActivityRoutes);
        },
        { prefix: "/admin/agents/activity" },
      );

      await api.register(
        async (adminApp) => {
          adminApp.addHook("onRequest", adminAuth);
          await adminApp.register(adminOrganizationRoutes);
        },
        { prefix: "/admin/organizations" },
      );

      await api.register(
        async (adminApp) => {
          adminApp.addHook("onRequest", adminAuth);
          await adminApp.register(adminStatsRoutes);
        },
        { prefix: "/admin/stats" },
      );

      await api.register(
        async (adminApp) => {
          adminApp.addHook("onRequest", adminAuth);
          await adminApp.register(adminTaskRoutes);
        },
        { prefix: "/admin/tasks" },
      );

      // Public routes (no auth)
      await api.register(publicAgentRoutes, { prefix: "/public/agents" });

      // Agent routes (Bearer token protected)
      await api.register(
        async (agentApp) => {
          agentApp.addHook("onRequest", agentAuth);
          await agentApp.register(agentMeRoutes);
          await agentApp.register(agentChatRoutes, { prefix: "/chats" });
          await agentApp.register(agentMessageRoutes, { prefix: "/chats" });
          await agentApp.register(agentSendToAgentRoutes, { prefix: "/agents" });
          await agentApp.register(agentInboxRoutes, { prefix: "/inbox" });
          await agentApp.register(agentTaskRoutes, { prefix: "/tasks" });

          await agentApp.register(agentFeishuBotRoutes);
          await agentApp.register(agentFeishuUserRoutes, { prefix: "/delegated" });
          await agentApp.register(agentWsRoutes(notifier, config.instanceId), { prefix: "/ws" });
        },
        { prefix: "/agent" },
      );

      // M1: Client WebSocket (no auth at WS level — auth via agent:bind message)
      await api.register(clientWsRoutes(notifier, config.instanceId), { prefix: "/agent/ws" });
    },
    { prefix: "/api/v1" },
  );

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

  // Register config change handler for hot reload
  notifier.onConfigChange((configType) => {
    if (configType === "adapter_configs") {
      adapterManager.reload().catch((err) => app.log.error(err, "Adapter hot-reload failed (PG NOTIFY)"));
      kaelRuntime?.reload().catch((err) => app.log.error(err, "Kael hot-reload failed (PG NOTIFY)"));
    }
  });

  // Start notifier and background tasks on server start
  app.addHook("onReady", async () => {
    // Ensure the default organization exists (idempotent)
    await ensureDefaultOrganization(db);
    await notifier.start();
    backgroundTasks.start();
    await adapterManager.reload();
    await kaelRuntime?.reload();
  });

  // Cleanup on close
  app.addHook("onClose", async () => {
    backgroundTasks.stop();
    adapterManager.shutdown();
    kaelRuntime?.shutdown();
    await notifier.stop();
    await listenClient.end();
    await db.end();
  });

  return app;
}
