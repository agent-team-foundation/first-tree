import { ENV_REDACTED_PLACEHOLDER } from "@agent-team-foundation/first-tree-hub-shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { agentConfigs } from "../db/schema/agent-configs.js";
import { isEncryptedValue } from "../services/crypto.js";
import { createTestAdmin, seedAgentFactory, useTestApp } from "./helpers.js";

describe("Admin agent-config API (Step 2)", () => {
  const getApp = useTestApp();

  async function authedRequest(app: FastifyInstance) {
    const admin = await createTestAdmin(app, {
      username: `admin-cfg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
    return (method: string, url: string, payload?: unknown) =>
      app.inject({
        method: method as "GET" | "POST" | "PATCH" | "DELETE",
        url,
        headers: { authorization: `Bearer ${admin.accessToken}` },
        ...(payload ? { payload } : {}),
      });
  }

  it("PATCH bumps version + GET returns the new payload", async () => {
    const app = getApp();
    const req = await authedRequest(app);
    const agent = await (await seedAgentFactory(app))({
      name: `cfg-patch-${crypto.randomUUID().slice(0, 8)}`,
      type: "autonomous_agent",
    });

    const before = await req("GET", `/api/v1/admin/agents/${agent.uuid}/config`);
    expect(before.statusCode).toBe(200);
    expect(before.json().version).toBe(1);

    const patch = await req("PATCH", `/api/v1/admin/agents/${agent.uuid}/config`, {
      expectedVersion: 1,
      payload: { model: "claude-opus-4-6", prompt: { append: "你只会一句话" } },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().version).toBe(2);
    expect(patch.json().payload.model).toBe("claude-opus-4-6");

    // Wait for debounce window to clear so the next test isn't queued behind us.
    await app.configService.flush(agent.uuid);

    const after = await req("GET", `/api/v1/admin/agents/${agent.uuid}/config`);
    expect(after.json().payload.model).toBe("claude-opus-4-6");
    expect(after.json().payload.prompt.append).toBe("你只会一句话");
  });

  it("PATCH with stale expectedVersion returns 409", async () => {
    const app = getApp();
    const req = await authedRequest(app);
    const agent = await (await seedAgentFactory(app))({
      name: `cfg-409-${crypto.randomUUID().slice(0, 8)}`,
      type: "autonomous_agent",
    });

    const r1 = await req("PATCH", `/api/v1/admin/agents/${agent.uuid}/config`, {
      expectedVersion: 1,
      payload: { model: "claude-opus-4-6" },
    });
    expect(r1.statusCode).toBe(200);
    await app.configService.flush(agent.uuid);

    // Re-using expectedVersion=1 → stale
    const r2 = await req("PATCH", `/api/v1/admin/agents/${agent.uuid}/config`, {
      expectedVersion: 1,
      payload: { model: "claude-haiku-4-5" },
    });
    expect(r2.statusCode).toBe(409);
  });

  it("dry-run returns diff without persisting", async () => {
    const app = getApp();
    const req = await authedRequest(app);
    const agent = await (await seedAgentFactory(app))({
      name: `cfg-dry-${crypto.randomUUID().slice(0, 8)}`,
      type: "autonomous_agent",
    });

    const dry = await req("POST", `/api/v1/admin/agents/${agent.uuid}/config/dry-run`, {
      payload: { model: "claude-opus-4-6" },
    });
    expect(dry.statusCode).toBe(200);
    const body = dry.json();
    expect(body.diff).toEqual([{ path: "model", op: "replace", before: "", after: "claude-opus-4-6" }]);
    expect(body.next.model).toBe("claude-opus-4-6");

    const get = await req("GET", `/api/v1/admin/agents/${agent.uuid}/config`);
    expect(get.json().payload.model).toBe(""); // unchanged
  });

  it("sensitive env value is encrypted at rest, masked in GET, decrypted via getDecrypted", async () => {
    const app = getApp();
    const req = await authedRequest(app);
    const agent = await (await seedAgentFactory(app))({
      name: `cfg-env-${crypto.randomUUID().slice(0, 8)}`,
      type: "autonomous_agent",
    });

    const patch = await req("PATCH", `/api/v1/admin/agents/${agent.uuid}/config`, {
      expectedVersion: 1,
      payload: {
        env: [
          { key: "OPENAI_API_KEY", value: "sk-secret-123", sensitive: true },
          { key: "PLAIN_VAR", value: "hello", sensitive: false },
        ],
      },
    });
    expect(patch.statusCode).toBe(200);
    await app.configService.flush(agent.uuid);

    // GET → masked
    const get = await req("GET", `/api/v1/admin/agents/${agent.uuid}/config`);
    const env = get.json().payload.env as Array<{ key: string; value: string; sensitive: boolean }>;
    expect(env.find((e) => e.key === "OPENAI_API_KEY")?.value).toBe(ENV_REDACTED_PLACEHOLDER);
    expect(env.find((e) => e.key === "PLAIN_VAR")?.value).toBe("hello");

    // Raw DB row → ciphertext
    const [row] = await app.db.select().from(agentConfigs).where(eq(agentConfigs.agentId, agent.uuid));
    const stored = row?.payload.env.find((e) => e.key === "OPENAI_API_KEY");
    expect(stored?.value).toBeDefined();
    expect(stored?.value && isEncryptedValue(stored.value)).toBe(true);

    // getDecrypted → plaintext
    const decrypted = await app.configService.getDecrypted(agent.uuid);
    const decryptedEnv = decrypted.payload.env.find((e) => e.key === "OPENAI_API_KEY");
    expect(decryptedEnv?.value).toBe("sk-secret-123");
  });

  it("re-saving a sensitive env with the redacted placeholder keeps the original ciphertext", async () => {
    const app = getApp();
    const req = await authedRequest(app);
    const agent = await (await seedAgentFactory(app))({
      name: `cfg-resave-${crypto.randomUUID().slice(0, 8)}`,
      type: "autonomous_agent",
    });

    await req("PATCH", `/api/v1/admin/agents/${agent.uuid}/config`, {
      expectedVersion: 1,
      payload: { env: [{ key: "TOKEN", value: "real-secret", sensitive: true }] },
    });
    await app.configService.flush(agent.uuid);
    const decrypted1 = await app.configService.getDecrypted(agent.uuid);
    const value1 = decrypted1.payload.env[0]?.value;

    // Admin re-saves a different field; the env arrives with the placeholder.
    await req("PATCH", `/api/v1/admin/agents/${agent.uuid}/config`, {
      expectedVersion: 2,
      payload: { env: [{ key: "TOKEN", value: ENV_REDACTED_PLACEHOLDER, sensitive: true }] },
    });
    await app.configService.flush(agent.uuid);
    const decrypted2 = await app.configService.getDecrypted(agent.uuid);
    expect(decrypted2.payload.env[0]?.value).toBe(value1);
  });

  it("debounce: concurrent PATCHes with stale expectedVersion each raise 409", async () => {
    const app = getApp();
    const req = await authedRequest(app);
    const agent = await (await seedAgentFactory(app))({
      name: `cfg-debounce-${crypto.randomUUID().slice(0, 8)}`,
      type: "autonomous_agent",
    });

    // Five concurrent writers all claiming expectedVersion=1. Exactly one
    // lands as the "first of burst" commit (v1→v2); the queued four each
    // receive their own 409 against v2 — the earlier "silently coalesce into
    // the aggregated patch" behavior violated PRD §5–7 versioned-PATCH
    // semantics (two admins editing `model` would both get 200 with one
    // winner's edit silently dropped).
    const settled = await Promise.allSettled([
      app.configService.update(agent.uuid, { expectedVersion: 1, payload: { prompt: { append: "v1" } } }, "test"),
      app.configService.update(agent.uuid, { expectedVersion: 1, payload: { prompt: { append: "v2" } } }, "test"),
      app.configService.update(agent.uuid, { expectedVersion: 1, payload: { prompt: { append: "v3" } } }, "test"),
      app.configService.update(agent.uuid, { expectedVersion: 1, payload: { prompt: { append: "v4" } } }, "test"),
      app.configService.update(agent.uuid, { expectedVersion: 1, payload: { prompt: { append: "v5" } } }, "test"),
    ]);
    const fulfilled = settled.filter((r) => r.status === "fulfilled");
    const rejected = settled.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(4);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toMatchObject({
        message: expect.stringMatching(/version mismatch/i),
      });
    }
    await app.configService.flush(agent.uuid);

    // Exactly one commit — v1→v2, not the pre-fix "1 immediate + 1 aggregated".
    const get = await req("GET", `/api/v1/admin/agents/${agent.uuid}/config`);
    expect(get.json().version).toBe(2);
  });

  it("PATCH triggers PG NOTIFY on config_changes", async () => {
    const app = getApp();
    const req = await authedRequest(app);
    const agent = await (await seedAgentFactory(app))({
      name: `cfg-notify-${crypto.randomUUID().slice(0, 8)}`,
      type: "autonomous_agent",
    });

    const events: string[] = [];
    app.notifier.onConfigChange((p) => events.push(p));

    await req("PATCH", `/api/v1/admin/agents/${agent.uuid}/config`, {
      expectedVersion: 1,
      payload: { model: "claude-opus-4-6" },
    });
    // PG NOTIFY is async — give it a tick.
    await new Promise((r) => setTimeout(r, 200));
    expect(events.some((e) => e === `agent:${agent.uuid}`)).toBe(true);
  });

  it("non-manager member is rejected with 404 (agent they do not manage)", async () => {
    // assertCanManage throws NotFoundError — 404 rather than 403, so the
    // request cannot be used to enumerate agent UUIDs a member cannot see.
    const app = getApp();
    const admin = await createTestAdmin(app, {
      username: `cfg-non-mgr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
    // seedAgentFactory creates its own admin as the manager — so the agent
    // below is NOT managed by `admin` above.
    const agent = await (await seedAgentFactory(app))({
      name: `cfg-404-${crypto.randomUUID().slice(0, 8)}`,
      type: "autonomous_agent",
    });

    // Demote to "member" via direct update.
    const { members } = await import("../db/schema/members.js");
    await app.db
      .update(members)
      .set({ role: "member" })
      .where(
        eq(
          members.userId,
          (
            await app.db
              .select({ id: (await import("../db/schema/users.js")).users.id })
              .from((await import("../db/schema/users.js")).users)
              .where(eq((await import("../db/schema/users.js")).users.username, admin.username))
              .limit(1)
          )[0]?.id ?? "",
        ),
      );

    // Re-login (the previous JWT still has role:admin baked in; need fresh token).
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: admin.username, password: admin.password },
    });
    const fresh = loginRes.json<{ accessToken: string }>();

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/agents/${agent.uuid}/config`,
      headers: { authorization: `Bearer ${fresh.accessToken}` },
      payload: { expectedVersion: 1, payload: { model: "claude-opus-4-6" } },
    });
    expect(res.statusCode).toBe(404);
  });

  it("manager (non-admin) can GET and PATCH config on an agent they manage", async () => {
    // Regression guard: prior to removing the plugin-scoped adminOnly hook on
    // /admin/agents/:uuid/config, a member editing their own personal_assistant
    // got "Admin role required" — blocking the documented "manager retains
    // CRUD" semantics from agents schema.
    const app = getApp();
    const { createAgent } = await import("../services/agent.js");
    const { members } = await import("../db/schema/members.js");
    const { users } = await import("../db/schema/users.js");
    const { clients } = await import("../db/schema/clients.js");

    // Create an admin, seed a client owned by them, create an agent managed
    // by them, then demote the member to "member" role.
    const admin = await createTestAdmin(app, {
      username: `cfg-mgr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
    const [member] = await app.db.select().from(members).where(eq(members.id, admin.memberId)).limit(1);
    if (!member) throw new Error("admin member missing");
    const clientId = `cli-mgr-${crypto.randomUUID().slice(0, 8)}`;
    await app.db.insert(clients).values({ id: clientId, userId: member.userId, status: "connected" });
    const agent = await createAgent(app.db, {
      name: `cfg-mgr-agent-${crypto.randomUUID().slice(0, 8)}`,
      type: "personal_assistant",
      displayName: "My Assistant",
      managerId: admin.memberId,
      clientId,
    });

    // Demote the member who manages this agent.
    await app.db
      .update(members)
      .set({ role: "member" })
      .where(
        eq(
          members.userId,
          (await app.db.select({ id: users.id }).from(users).where(eq(users.username, admin.username)).limit(1))[0]
            ?.id ?? "",
        ),
      );

    // Fresh JWT so role:"member" replaces the cached role:"admin".
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: admin.username, password: admin.password },
    });
    const fresh = loginRes.json<{ accessToken: string }>();
    const auth = { authorization: `Bearer ${fresh.accessToken}` };

    // GET — manager can read config (assertCanManage allows managerId = self).
    const get = await app.inject({
      method: "GET",
      url: `/api/v1/admin/agents/${agent.uuid}/config`,
      headers: auth,
    });
    expect(get.statusCode).toBe(200);
    expect(get.json().version).toBe(1);

    // PATCH — manager can edit config (assertCanManage allows managerId = self).
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/agents/${agent.uuid}/config`,
      headers: auth,
      payload: { expectedVersion: 1, payload: { model: "claude-opus-4-6" } },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().payload.model).toBe("claude-opus-4-6");
  });

  it("non-manager member cannot GET config even when agent is org-visible", async () => {
    // Behavior (system prompt, tools, env) is manager-only — visibility only
    // grants card-view access (GET /admin/agents/:uuid), not internal config.
    // This mirrors ChatGPT Custom GPTs / Poe / Slack bots: "usable by org ≠
    // prompt readable by org".
    const app = getApp();
    const { createAgent } = await import("../services/agent.js");
    const { members } = await import("../db/schema/members.js");
    const { users } = await import("../db/schema/users.js");
    const { clients } = await import("../db/schema/clients.js");

    // Manager admin creates an org-visible agent.
    const manager = await createTestAdmin(app, {
      username: `cfg-vis-mgr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
    const [mgrMember] = await app.db.select().from(members).where(eq(members.id, manager.memberId)).limit(1);
    if (!mgrMember) throw new Error("manager member missing");
    const clientId = `cli-vis-${crypto.randomUUID().slice(0, 8)}`;
    await app.db.insert(clients).values({ id: clientId, userId: mgrMember.userId, status: "connected" });
    const agent = await createAgent(app.db, {
      name: `cfg-vis-agent-${crypto.randomUUID().slice(0, 8)}`,
      type: "autonomous_agent",
      displayName: "Shared Agent",
      managerId: manager.memberId,
      clientId,
      visibility: "organization",
    });

    // A different member in the same org — has visibility but is not manager.
    const viewer = await createTestAdmin(app, {
      username: `cfg-vis-viewer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
    await app.db
      .update(members)
      .set({ role: "member" })
      .where(
        eq(
          members.userId,
          (await app.db.select({ id: users.id }).from(users).where(eq(users.username, viewer.username)).limit(1))[0]
            ?.id ?? "",
        ),
      );
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: viewer.username, password: viewer.password },
    });
    const fresh = loginRes.json<{ accessToken: string }>();
    const auth = { authorization: `Bearer ${fresh.accessToken}` };

    // Card view works — agent IS visible to this member.
    const card = await app.inject({
      method: "GET",
      url: `/api/v1/admin/agents/${agent.uuid}`,
      headers: auth,
    });
    expect(card.statusCode).toBe(200);
    expect(card.json().uuid).toBe(agent.uuid);

    // But config (behavior) is not readable — manager-only.
    const cfg = await app.inject({
      method: "GET",
      url: `/api/v1/admin/agents/${agent.uuid}/config`,
      headers: auth,
    });
    expect(cfg.statusCode).toBe(404);
  });
});
