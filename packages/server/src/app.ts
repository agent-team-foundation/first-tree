import { existsSync } from "node:fs";
import { resolve } from "node:path";
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
import { adminAgentSyncRoutes } from "./api/admin/agent-sync.js";
import { adminAgentRoutes } from "./api/admin/agents.js";
import { adminAuthRoutes } from "./api/admin/auth.js";
import { adminChatRoutes } from "./api/admin/chats.js";
import { adminOverviewRoutes } from "./api/admin/overview.js";
import { adminSystemConfigRoutes } from "./api/admin/system-config.js";
import { adminUserRoutes } from "./api/admin/users.js";
import { agentChatRoutes } from "./api/agent/chats.js";
import { agentInboxRoutes } from "./api/agent/inbox.js";
import { agentMeRoutes } from "./api/agent/me.js";
import { agentMessageRoutes, agentSendToAgentRoutes } from "./api/agent/messages.js";
import { agentWsRoutes } from "./api/agent/ws.js";
import { healthRoutes } from "./api/health.js";
import { githubWebhookRoutes } from "./api/webhooks/github.js";
import type { Config } from "./config.js";
import { connectDatabase } from "./db/connection.js";
import { AppError } from "./errors.js";
import { adminAuthHook } from "./middleware/admin-auth.js";
import { agentAuthHook } from "./middleware/agent-auth.js";
import { type AdapterManager, createAdapterManager } from "./services/adapter-manager.js";
import { stopPeriodicSync } from "./services/agent-sync.js";
import { type BackgroundTasks, createBackgroundTasks } from "./services/background-tasks.js";
import { syncFromGitHub } from "./services/context-tree-graphql.js";
import { createNotifier, type Notifier } from "./services/notifier.js";

// Fastify type augmentation
import "./types.js";

export type AppContext = {
  notifier: Notifier;
  backgroundTasks: BackgroundTasks;
  adapterManager: AdapterManager;
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

  // CORS — default: same-origin only; configurable via env
  const corsOrigin = process.env.AGENT_HUB_CORS_ORIGIN;
  await app.register(cors, {
    origin: corsOrigin ? corsOrigin.split(",").map((s) => s.trim()) : false,
    credentials: true,
  });

  // Rate limiting — global default; overridden per-route where needed
  const globalMax = Number(process.env.AGENT_HUB_RATE_LIMIT_MAX) || 100;
  await app.register(rateLimit, {
    max: globalMax,
    timeWindow: "1 minute",
  });

  // Auth hooks
  const agentAuth = agentAuthHook(db);
  const adminAuth = adminAuthHook(db, config.secrets.jwtSecret);

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

  // All API routes under /api/v1 prefix
  await app.register(
    async (api) => {
      // Public routes
      await api.register(healthRoutes);
      await api.register(githubWebhookRoutes, { prefix: "/webhooks" });
      await api.register(adminAuthRoutes, { prefix: "/admin/auth" });

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
          await adminApp.register(adminAgentSyncRoutes);
        },
        { prefix: "/admin/agents/sync" },
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

      // Agent routes (Bearer token protected)
      await api.register(
        async (agentApp) => {
          agentApp.addHook("onRequest", agentAuth);
          await agentApp.register(agentMeRoutes);
          await agentApp.register(agentChatRoutes, { prefix: "/chats" });
          await agentApp.register(agentMessageRoutes, { prefix: "/chats" });
          await agentApp.register(agentSendToAgentRoutes, { prefix: "/agents" });
          await agentApp.register(agentInboxRoutes, { prefix: "/inbox" });
          await agentApp.register(agentWsRoutes(notifier, config.instanceId), { prefix: "/ws" });
        },
        { prefix: "/agent" },
      );
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

  // Background tasks
  const backgroundTasks = createBackgroundTasks(app, config.instanceId, adapterManager);

  // Register config change handler for hot reload
  notifier.onConfigChange((configType) => {
    if (configType === "adapter_configs") {
      adapterManager.reload().catch((err) => app.log.error(err, "Adapter hot-reload failed (PG NOTIFY)"));
    }
  });

  // Start notifier and background tasks on server start
  app.addHook("onReady", async () => {
    await notifier.start();
    backgroundTasks.start();
    await adapterManager.reload();

    // Context Tree sync via GitHub GraphQL
    const { repo: ctRepo, branch: ctBranch, syncInterval } = config.contextTree;
    const { token: ghToken } = config.github;
    try {
      const report = await syncFromGitHub(db, ctRepo, ctBranch, ghToken);
      app.log.info(
        `Context Tree sync: created=${report.created} updated=${report.updated} unchanged=${report.unchanged} errors=${report.errors}`,
      );
    } catch (err) {
      app.log.error(err, "Initial Context Tree sync failed");
    }

    // Periodic sync
    const intervalMs = syncInterval * 1000;
    const timer = setInterval(() => {
      syncFromGitHub(db, ctRepo, ctBranch, ghToken).catch((err) =>
        app.log.error(err, "Periodic Context Tree sync failed"),
      );
    }, intervalMs);
    app.addHook("onClose", async () => clearInterval(timer));
  });

  // Cleanup on close
  app.addHook("onClose", async () => {
    stopPeriodicSync();
    backgroundTasks.stop();
    adapterManager.shutdown();
    await notifier.stop();
    await listenClient.end();
  });

  return app;
}
