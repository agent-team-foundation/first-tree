import type { AgentType } from "@agent-team-foundation/first-tree-hub-shared";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll } from "vitest";
import { buildApp } from "../app.js";
import type { Config } from "../config.js";

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

type AgentRequestFn = (
  method: string,
  url: string,
  payload?: unknown,
  extraHeaders?: Record<string, string>,
) => Promise<InjectResponse>;

export async function createTestApp(): Promise<FastifyInstance> {
  const config: Config = {
    database: {
      url: process.env.DATABASE_URL ?? "",
      provider: "external",
    },
    server: {
      port: 0,
      host: "127.0.0.1",
      publicUrl: undefined,
    },
    secrets: {
      jwtSecret: process.env.JWT_SECRET ?? "test-jwt-secret-key-for-vitest",
      encryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    },
    github: {
      webhookSecret: "test-webhook-secret",
      allowedOrg: "test-org",
    },
    oauth: {
      github: {
        clientId: "test-github-client",
        clientSecret: "test-github-secret",
        devCallbackEnabled: true,
      },
    },
    rateLimit: { max: 10000, loginMax: 10000, webhookMax: 10000 },
    observability: {
      logging: { level: "error", format: "json", bridgeToSpanLevel: "off" },
    },
    instanceId: "test-instance",
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

/**
 * Create a user + admin member, seed a client row owned by that user, create
 * an agent pinned to that client, and return JWT access token + X-Agent-Id
 * header value. Tests use this helper to hit agent-scoped routes with the
 * unified-user-token middleware chain.
 */
export async function createTestAgent(
  app: FastifyInstance,
  opts: { name?: string; type?: AgentType; displayName?: string } = {},
) {
  const admin = await createTestAdmin(app, { username: `u-${crypto.randomUUID().slice(0, 8)}` });

  const { clients } = await import("../db/schema/clients.js");
  const { members } = await import("../db/schema/members.js");
  const { eq } = await import("drizzle-orm");
  const [member] = await app.db.select().from(members).where(eq(members.id, admin.memberId)).limit(1);
  if (!member) throw new Error("admin member missing after setup");
  const clientId = `cli-${crypto.randomUUID().slice(0, 8)}`;
  await app.db.insert(clients).values({
    id: clientId,
    userId: member.userId,
    organizationId: member.organizationId,
    status: "connected",
  });

  const { createAgent } = await import("../services/agent.js");
  const type = opts.type ?? "autonomous_agent";
  const agent = await createAgent(app.db, {
    name: opts.name ?? `test-agent-${crypto.randomUUID().slice(0, 8)}`,
    type,
    displayName: opts.displayName ?? "Test Agent",
    managerId: admin.memberId,
    ...(type === "human" ? {} : { clientId }),
  });

  // `token` is kept as an alias for the user's JWT so the large body of
  // pre-unified-token tests still compiles; those tests will additionally
  // need to send `X-Agent-Id: agent.uuid` at runtime to pass the new
  // middleware chain. The alias is a migration aid, not a permanent API.
  return {
    agent,
    accessToken: admin.accessToken,
    token: admin.accessToken,
    clientId,
    memberId: admin.memberId,
    userId: member.userId,
    organizationId: member.organizationId,
    /** Agent-scoped request — adds `Authorization` + `x-agent-id` headers. */
    request: ((method, url, payload, extraHeaders) =>
      app.inject({
        method: method as "GET" | "POST" | "PATCH" | "DELETE",
        url,
        headers: {
          authorization: `Bearer ${admin.accessToken}`,
          "x-agent-id": agent.uuid,
          ...extraHeaders,
        },
        ...(payload ? { payload } : {}),
      })) as AgentRequestFn,
  };
}

/**
 * Build an ad-hoc agent-scoped request function from an accessToken + agentId.
 * Useful when the test already has the pieces and doesn't need a fresh agent.
 */
export function agentRequest(app: FastifyInstance, accessToken: string, agentUuid: string): AgentRequestFn {
  return (method, url, payload) =>
    app.inject({
      method: method as "GET" | "POST" | "PATCH" | "DELETE",
      url,
      headers: { authorization: `Bearer ${accessToken}`, "x-agent-id": agentUuid },
      ...(payload ? { payload } : {}),
    });
}

/**
 * Spin up a full create-agent prerequisite chain (admin + client) and return
 * a callable that invokes the service-layer `createAgent` with the pinning
 * defaults pre-filled. Use in unit tests that want to exercise config /
 * lifecycle behavior without re-deriving the admin/client bootstrap each
 * time.
 */
export async function seedAgentFactory(app: FastifyInstance) {
  const admin = await createTestAdmin(app, { username: `seed-${crypto.randomUUID().slice(0, 8)}` });
  const { clients } = await import("../db/schema/clients.js");
  const { members } = await import("../db/schema/members.js");
  const { eq } = await import("drizzle-orm");
  const [member] = await app.db.select().from(members).where(eq(members.id, admin.memberId)).limit(1);
  if (!member) throw new Error("seed admin member missing");
  const clientId = `cli-seed-${crypto.randomUUID().slice(0, 8)}`;
  await app.db.insert(clients).values({
    id: clientId,
    userId: member.userId,
    organizationId: member.organizationId,
    status: "connected",
  });

  const { createAgent } = await import("../services/agent.js");
  return async (opts: { name?: string; type?: AgentType; displayName?: string } = {}) => {
    return createAgent(app.db, {
      name: opts.name ?? `seed-agent-${crypto.randomUUID().slice(0, 8)}`,
      type: opts.type ?? "autonomous_agent",
      displayName: opts.displayName ?? "Seed Agent",
      managerId: admin.memberId,
      clientId: opts.type === "human" ? undefined : clientId,
    });
  };
}

/** Seed a claimed, connected `clients` row owned by `userId` within `organizationId`. Returns the id. */
export async function seedClient(app: FastifyInstance, userId: string, organizationId: string): Promise<string> {
  const { clients } = await import("../db/schema/clients.js");
  const id = `cli-${crypto.randomUUID().slice(0, 8)}`;
  await app.db.insert(clients).values({ id, userId, organizationId, status: "connected" });
  return id;
}

/**
 * Admin + a seeded client owned by that admin's user. Most test suites need
 * both — non-human agents created by the admin must pin to a client after
 * M1 Rule R-RUN, and tests that call `createAgent` directly need the
 * `clientId` to pass resolveAgentClient's owner check.
 */
export async function createAdminContext(app: FastifyInstance, opts: { username?: string; password?: string } = {}) {
  const admin = await createTestAdmin(app, opts);
  const { members } = await import("../db/schema/members.js");
  const { eq } = await import("drizzle-orm");
  const [member] = await app.db.select().from(members).where(eq(members.id, admin.memberId)).limit(1);
  if (!member) throw new Error("admin member missing after setup");
  const clientId = await seedClient(app, member.userId, member.organizationId);
  return { ...admin, clientId, userId: member.userId, organizationId: member.organizationId };
}

/** Create a user + admin member + human agent and return JWT + memberId. */
export async function createTestAdmin(app: FastifyInstance, opts: { username?: string; password?: string } = {}) {
  const bcrypt = await import("bcrypt");
  const { users } = await import("../db/schema/users.js");
  const { members } = await import("../db/schema/members.js");
  const { uuidv7 } = await import("../uuid.js");
  const { createAgent } = await import("../services/agent.js");
  const { resolveDefaultOrgId } = await import("../services/organization.js");

  const username = opts.username ?? `admin-${crypto.randomUUID().slice(0, 8)}`;
  const password = opts.password ?? "testpassword123";
  const passwordHash = await bcrypt.hash(password, 1);

  const userId = uuidv7();
  const orgId = await resolveDefaultOrgId(app.db);
  const memberId = uuidv7();

  // agents.manager_id ↔ members.agent_id is a FK cycle; the unified-user-token
  // migration (0019) makes agents.manager_id deferred so both rows can be
  // inserted in one transaction. Mirrors services/member.ts::createMember.
  const agent = await app.db.transaction(async (tx) => {
    await tx.insert(users).values({
      id: userId,
      username,
      passwordHash,
      displayName: "Test Admin",
    });

    const created = await createAgent(tx as unknown as typeof app.db, {
      name: `test-admin-${crypto.randomUUID().slice(0, 8)}`,
      type: "human",
      displayName: "Test Admin",
      source: "admin-api",
      managerId: memberId,
      organizationId: orgId,
    });

    await tx.insert(members).values({
      id: memberId,
      userId,
      organizationId: orgId,
      agentId: created.uuid,
      role: "admin",
    });

    return created;
  });

  const loginRes = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username, password },
  });
  const body = loginRes.json<{ accessToken: string; refreshToken: string }>();
  return { username, password, userId, memberId, organizationId: orgId, humanAgentUuid: agent.uuid, ...body };
}
