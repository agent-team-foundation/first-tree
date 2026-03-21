import Fastify from "fastify";
import { ZodError } from "zod";
import { adminAgentRoutes } from "./api/admin/agents.js";
import { adminAuthRoutes } from "./api/admin/auth.js";
import { agentChatRoutes } from "./api/agent/chats.js";
import { agentInboxRoutes } from "./api/agent/inbox.js";
import { agentMeRoutes } from "./api/agent/me.js";
import { agentMessageRoutes } from "./api/agent/messages.js";
import { healthRoutes } from "./api/health.js";
import type { Config } from "./config.js";
import { connectDatabase } from "./db/connection.js";
import { AppError } from "./errors.js";
import { adminAuthHook } from "./middleware/admin-auth.js";
import { agentAuthHook } from "./middleware/agent-auth.js";

// Fastify type augmentation
import "./types.js";

export async function buildApp(config: Config) {
  const app = Fastify({ logger: config.logger ?? true });

  // Decorate with config and db
  const db = connectDatabase(config.databaseUrl);
  app.decorate("db", db);
  app.decorate("config", config);

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

  // Public routes
  await app.register(healthRoutes);
  await app.register(adminAuthRoutes, { prefix: "/admin/auth" });

  // Admin routes (JWT protected)
  await app.register(
    async (adminApp) => {
      adminApp.addHook("onRequest", adminAuth);
      await adminApp.register(adminAgentRoutes);
    },
    { prefix: "/admin/agents" },
  );

  // Agent routes (Bearer token protected)
  // V1: actor-centric paths (/agent/*) for simplicity.
  // Target: migrate to resource-centric paths (/chats/*, /inboxes/*) per design doc
  // (agent-hub-server-detailed-design §4.1). Body schemas are shared, so migration is path-only.
  await app.register(
    async (agentApp) => {
      agentApp.addHook("onRequest", agentAuth);
      await agentApp.register(agentMeRoutes);
      await agentApp.register(agentChatRoutes, { prefix: "/chats" });
      await agentApp.register(agentMessageRoutes, { prefix: "/chats" });
      await agentApp.register(agentInboxRoutes, { prefix: "/inbox" });
    },
    { prefix: "/agent" },
  );

  return app;
}
