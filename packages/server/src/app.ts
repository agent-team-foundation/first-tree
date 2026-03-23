import { existsSync } from "node:fs";
import { resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import postgres from "postgres";
import { ZodError } from "zod";
import { adminAdapterRoutes } from "./api/admin/adapters.js";
import { adminAgentRoutes } from "./api/admin/agents.js";
import { adminAuthRoutes } from "./api/admin/auth.js";
import { adminOverviewRoutes } from "./api/admin/overview.js";
import { adminSystemConfigRoutes } from "./api/admin/system-config.js";
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
import { type BackgroundTasks, createBackgroundTasks } from "./services/background-tasks.js";
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
  const db = connectDatabase(config.databaseUrl);
  app.decorate("db", db);
  app.decorate("config", config);

  // Notifier: dedicated PG connection for LISTEN/NOTIFY
  const listenClient = postgres(config.databaseUrl, { max: 1 });
  const notifier = createNotifier(listenClient);

  // WebSocket plugin
  await app.register(websocket);

  // Auth hooks
  const agentAuth = agentAuthHook(db);
  const adminAuth = adminAuthHook(db, config.jwtSecretKey);

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

  // Serve Web static files when WEB_DIST_PATH is configured
  if (config.webDistPath) {
    const webRoot = resolve(config.webDistPath);
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

  // Adapter manager — decorated so admin routes can trigger reload
  const adapterManager = createAdapterManager(db, config.adapterEncryptionKey, app.log);
  app.decorate("adapterManager", adapterManager);

  // Background tasks
  const backgroundTasks = createBackgroundTasks(app, config.instanceId, adapterManager);

  // Start notifier and background tasks on server start
  app.addHook("onReady", async () => {
    await notifier.start();
    backgroundTasks.start();
    if (!config.adapterEncryptionKey) {
      app.log.warn("ADAPTER_ENCRYPTION_KEY is not set — adapter create/update will be unavailable");
    } else {
      await adapterManager.reload();
    }
  });

  // Cleanup on close
  app.addHook("onClose", async () => {
    backgroundTasks.stop();
    adapterManager.shutdown();
    await notifier.stop();
    await listenClient.end();
  });

  return app;
}
