import type { AgentType } from "@agent-team-foundation/first-tree-hub-shared";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll } from "vitest";
import { buildApp } from "../app.js";
import type { Config } from "../config.js";

export async function createTestApp(): Promise<FastifyInstance> {
  const config: Config = {
    database: {
      url: process.env.DATABASE_URL ?? "",
      provider: "external",
    },
    server: {
      port: 0,
      host: "127.0.0.1",
    },
    secrets: {
      jwtSecret: process.env.JWT_SECRET ?? "test-jwt-secret-key-for-vitest",
      encryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    },
    github: {
      webhookSecret: "test-webhook-secret",
      allowedOrg: "test-org",
    },
    rateLimit: { max: 10000, loginMax: 10000, webhookMax: 10000 },
    instanceId: "test-instance",
    logger: false,
  };
  const app = await buildApp(config);
  await app.ready();
  return app;
}

/** Lazy test app lifecycle — creates in beforeAll, closes in afterAll. */
export function useTestApp() {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app?.close();
  });
  return () => app;
}

/** Create an agent via direct DB insert and return its bearer token. */
export async function createTestAgent(
  app: FastifyInstance,
  opts: { name?: string; type?: AgentType; displayName?: string } = {},
) {
  const { createAgent, createToken } = await import("../services/agent.js");
  const agent = await createAgent(app.db, {
    name: opts.name ?? `test-agent-${crypto.randomUUID().slice(0, 8)}`,
    type: opts.type ?? "autonomous_agent",
    displayName: opts.displayName ?? "Test Agent",
  });
  const token = await createToken(app.db, agent.uuid, { name: "test" });
  return { agent, token: token.token };
}

/** Create a user + member + human agent and return JWT tokens. */
export async function createTestAdmin(app: FastifyInstance, opts: { username?: string; password?: string } = {}) {
  const bcrypt = await import("bcrypt");
  const { users } = await import("../db/schema/users.js");
  const { members } = await import("../db/schema/members.js");
  const { uuidv7 } = await import("../uuid.js");
  const { createAgent } = await import("../services/agent.js");

  const username = opts.username ?? "admin";
  const password = opts.password ?? "testpassword123";
  const passwordHash = await bcrypt.hash(password, 1);

  const userId = uuidv7();
  await app.db.insert(users).values({
    id: userId,
    username,
    passwordHash,
    displayName: "Test Admin",
  });

  // Create human agent for this member
  const agent = await createAgent(app.db, {
    name: `test-admin-${userId.slice(0, 8)}`,
    type: "human",
    displayName: "Test Admin",
    source: "admin-api",
  });

  const memberId = uuidv7();
  await app.db.insert(members).values({
    id: memberId,
    userId,
    organizationId: agent.organizationId,
    agentId: agent.uuid,
    role: "admin",
  });

  // Set manager_id on the human agent (match production behavior)
  const { agents } = await import("../db/schema/agents.js");
  const { eq } = await import("drizzle-orm");
  await app.db.update(agents).set({ managerId: memberId }).where(eq(agents.uuid, agent.uuid));

  const loginRes = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username, password },
  });
  const body = loginRes.json<{ accessToken: string; refreshToken: string }>();
  return { username, password, ...body };
}
