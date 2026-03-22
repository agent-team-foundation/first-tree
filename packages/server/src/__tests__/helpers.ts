import type { AgentType } from "@agent-hub/shared";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import type { Config } from "../config.js";

export async function createTestApp(): Promise<FastifyInstance> {
  const config: Config = {
    databaseUrl: process.env.DATABASE_URL ?? "",
    serverHost: "127.0.0.1",
    serverPort: 0,
    logger: false,
    jwtSecretKey: process.env.JWT_SECRET_KEY ?? "test-jwt-secret-key-for-vitest",
    instanceId: "test-instance",
  };
  const app = await buildApp(config);
  await app.ready();
  return app;
}

/** Create an agent via direct DB insert and return its bearer token. */
export async function createTestAgent(
  app: FastifyInstance,
  opts: { id?: string; type?: AgentType; displayName?: string } = {},
) {
  const { createAgent, createToken } = await import("../services/agent.js");
  const agent = await createAgent(app.db, {
    id: opts.id ?? `test-agent-${crypto.randomUUID().slice(0, 8)}`,
    type: opts.type ?? "autonomous_agent",
    displayName: opts.displayName ?? "Test Agent",
  });
  const token = await createToken(app.db, agent.id, { name: "test" });
  return { agent, token: token.token };
}

/** Create an admin user and return JWT tokens. */
export async function createTestAdmin(app: FastifyInstance, opts: { username?: string; password?: string } = {}) {
  const bcrypt = await import("bcrypt");
  const { randomUUID } = await import("node:crypto");
  const { adminUsers } = await import("../db/schema/admin-users.js");

  const username = opts.username ?? "admin";
  const password = opts.password ?? "testpassword123";
  const passwordHash = await bcrypt.hash(password, 10);

  await app.db.insert(adminUsers).values({
    id: randomUUID(),
    username,
    passwordHash,
    role: "super_admin",
  });

  const loginRes = await app.inject({
    method: "POST",
    url: "/admin/auth/login",
    payload: { username, password },
  });
  const body = loginRes.json<{ accessToken: string; refreshToken: string }>();
  return { username, password, ...body };
}
