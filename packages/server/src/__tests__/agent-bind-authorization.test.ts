import { AGENT_RUNTIME_SESSION_HEADER, AGENT_SELECTOR_HEADER } from "@first-tree/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { clients } from "../db/schema/clients.js";
import { members } from "../db/schema/members.js";
import { agentSelectorHook } from "../middleware/agent-selector.js";
import { bindAgentRuntimeSession, revokeAgentRuntimeSession } from "../services/agent-runtime-session.js";
import { createTestAdmin, createTestAgent, useTestApp } from "./helpers.js";

/**
 * Rule R-RUN — agent-selector middleware enforces:
 *   - Target agent is pinned to a client owned by the caller's user.
 *   - Agent is active.
 *   - Agent belongs to the caller's organisation.
 *
 * Only agent-scoped HTTP routes exercise the middleware (/api/v1/agent/*).
 * `/me` is the simplest pass-through.
 */
describe("Rule R-RUN on agent-scoped HTTP", () => {
  const getApp = useTestApp();

  it("accepts a request pinned to the caller's client", async () => {
    const app = getApp();
    const { agent, accessToken } = await createTestAgent(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/agent/me",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "x-agent-id": agent.uuid,
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it("accepts a valid runtime session token before enforcement is enabled", async () => {
    const app = getApp();
    const { agent, clientId, accessToken } = await createTestAgent(app);
    const runtimeSessionToken = await bindAgentRuntimeSession(app.db, agent.uuid, clientId);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/agent/me",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "x-agent-id": agent.uuid,
        [AGENT_RUNTIME_SESSION_HEADER]: runtimeSessionToken,
      },
    });

    expect(res.statusCode).toBe(200);
  });

  it("rejects an invalid runtime session token even before enforcement is enabled", async () => {
    const app = getApp();
    const { agent, clientId, accessToken } = await createTestAgent(app);
    await bindAgentRuntimeSession(app.db, agent.uuid, clientId);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/agent/me",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "x-agent-id": agent.uuid,
        [AGENT_RUNTIME_SESSION_HEADER]: "not-current-token",
      },
    });

    expect(res.statusCode).toBe(403);
  });

  it("rejects when the pinned client belongs to a different user (not_owned)", async () => {
    const app = getApp();
    const { agent } = await createTestAgent(app);
    const other = await createTestAdmin(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/agent/me",
      headers: {
        authorization: `Bearer ${other.accessToken}`,
        "x-agent-id": agent.uuid,
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects when the agent has no pinned client (unclaimed)", async () => {
    const app = getApp();
    const { agent, accessToken } = await createTestAgent(app);
    // Detach the agent from any client to simulate the legacy `clientId IS NULL` state.
    await app.db.update(agents).set({ clientId: null }).where(eq(agents.uuid, agent.uuid));

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/agent/me",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "x-agent-id": agent.uuid,
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects when the pinned client has no user (legacy claim)", async () => {
    const app = getApp();
    const { agent, clientId, accessToken } = await createTestAgent(app);
    // Simulate an unclaimed legacy client row.
    await app.db.update(clients).set({ userId: null }).where(eq(clients.id, clientId));

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/agent/me",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "x-agent-id": agent.uuid,
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects when the agent is suspended", async () => {
    const app = getApp();
    const { agent, accessToken } = await createTestAgent(app);
    await app.db.update(agents).set({ status: "suspended" }).where(eq(agents.uuid, agent.uuid));

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/agent/me",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "x-agent-id": agent.uuid,
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects when X-Agent-Id is missing", async () => {
    const app = getApp();
    const { accessToken } = await createTestAgent(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/agent/me",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects when the selected agent row is missing", async () => {
    const app = getApp();
    const { accessToken } = await createTestAgent(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/agent/me",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "x-agent-id": crypto.randomUUID(),
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: string }>().error).toMatch(/Agent not found/);
  });

  it("rejects when the authenticated user no longer has active org membership", async () => {
    const app = getApp();
    const { agent } = await createTestAgent(app);
    const other = await createTestAdmin(app);
    await app.db.update(members).set({ status: "left" }).where(eq(members.id, other.memberId));

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/agent/me",
      headers: {
        authorization: `Bearer ${other.accessToken}`,
        "x-agent-id": agent.uuid,
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: string }>().error).toMatch(/caller is not a member/);
  });

  it("rejects human-agent selection by a different active member", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const other = await createTestAdmin(app);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/agent/me",
      headers: {
        authorization: `Bearer ${other.accessToken}`,
        "x-agent-id": admin.humanAgentUuid,
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: string }>().error).toMatch(/Agent not runnable/);
  });

  it("rejects missing user state and mismatched agent-outbox state inside the selector hook", async () => {
    const app = getApp();
    const { agent, userId } = await createTestAgent(app);
    const hook = agentSelectorHook(app.db);

    await expect(hook({ headers: {} } as never, {} as never)).rejects.toThrow(/User authentication required/);

    await expect(
      hook(
        {
          user: { userId, agentOutbox: { agentId: crypto.randomUUID() } },
          headers: { [AGENT_SELECTOR_HEADER]: agent.uuid },
        } as never,
        {} as never,
      ),
    ).rejects.toThrow(/outbox token is not valid/);
  });
});

describe("runtime-bound agent HTTP enforcement", () => {
  const getApp = useTestApp({ runtimeHttpTokenEnforcement: true });

  it("rejects non-human agent HTTP without a runtime session token", async () => {
    const app = getApp();
    const { agent, accessToken } = await createTestAgent(app);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/agent/me",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "x-agent-id": agent.uuid,
      },
    });

    expect(res.statusCode).toBe(403);
  });

  it("accepts non-human agent HTTP with the current runtime session token", async () => {
    const app = getApp();
    const { agent, clientId, accessToken } = await createTestAgent(app);
    const runtimeSessionToken = await bindAgentRuntimeSession(app.db, agent.uuid, clientId);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/agent/me",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "x-agent-id": agent.uuid,
        [AGENT_RUNTIME_SESSION_HEADER]: runtimeSessionToken,
      },
    });

    expect(res.statusCode).toBe(200);
  });

  it("accepts runtime session tokens from durable DB state without local WS ownership", async () => {
    const app = getApp();
    const { agent, clientId, accessToken } = await createTestAgent(app);
    const runtimeSessionToken = await bindAgentRuntimeSession(app.db, agent.uuid, clientId);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/agent/me",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "x-agent-id": agent.uuid,
        [AGENT_RUNTIME_SESSION_HEADER]: runtimeSessionToken,
      },
    });

    expect(res.statusCode).toBe(200);
  });

  it("accepts scoped agent outbox message writes without a runtime session token", async () => {
    const app = getApp();
    const sender = await createTestAgent(app, { name: `outbox-sender-${crypto.randomUUID().slice(0, 6)}` });
    const recipient = await createTestAgent(app, { name: `outbox-recipient-${crypto.randomUUID().slice(0, 6)}` });
    const runtimeSessionToken = await bindAgentRuntimeSession(app.db, sender.agent.uuid, sender.clientId);

    const chatRes = await sender.request(
      "POST",
      "/api/v1/agent/chats",
      {
        type: "group",
        participantIds: [recipient.agent.uuid],
      },
      { [AGENT_RUNTIME_SESSION_HEADER]: runtimeSessionToken },
    );
    expect(chatRes.statusCode).toBe(201);
    const chatId = chatRes.json<{ id: string }>().id;

    const tokenRes = await sender.request("POST", `/api/v1/agent/chats/${chatId}/outbox-token`, undefined, {
      [AGENT_RUNTIME_SESSION_HEADER]: runtimeSessionToken,
    });
    expect(tokenRes.statusCode).toBe(200);
    const outbox = tokenRes.json<{ accessToken: string }>();

    const send = await app.inject({
      method: "POST",
      url: `/api/v1/agent/chats/${chatId}/messages`,
      headers: {
        authorization: `Bearer ${outbox.accessToken}`,
        "x-agent-id": sender.agent.uuid,
      },
      payload: {
        format: "text",
        content: "Final trial report.",
        metadata: { mentions: [recipient.agent.uuid] },
        source: "cli",
      },
    });
    expect(send.statusCode).toBe(201);

    const wrongPath = await app.inject({
      method: "GET",
      url: `/api/v1/agent/chats/${chatId}/messages`,
      headers: {
        authorization: `Bearer ${outbox.accessToken}`,
        "x-agent-id": sender.agent.uuid,
      },
    });
    expect(wrongPath.statusCode).toBe(401);

    const wrongSibling = await app.inject({
      method: "POST",
      url: `/api/v1/agent/chats/${chatId}/outbox-token`,
      headers: {
        authorization: `Bearer ${outbox.accessToken}`,
        "x-agent-id": sender.agent.uuid,
      },
    });
    expect(wrongSibling.statusCode).toBe(401);

    const otherChatRes = await sender.request(
      "POST",
      "/api/v1/agent/chats",
      {
        type: "group",
        participantIds: [recipient.agent.uuid],
      },
      { [AGENT_RUNTIME_SESSION_HEADER]: runtimeSessionToken },
    );
    expect(otherChatRes.statusCode).toBe(201);
    const otherChatId = otherChatRes.json<{ id: string }>().id;
    const wrongChat = await app.inject({
      method: "POST",
      url: `/api/v1/agent/chats/${otherChatId}/messages`,
      headers: {
        authorization: `Bearer ${outbox.accessToken}`,
        "x-agent-id": sender.agent.uuid,
      },
      payload: {
        format: "text",
        content: "Wrong chat.",
        metadata: { mentions: [recipient.agent.uuid] },
        source: "cli",
      },
    });
    expect(wrongChat.statusCode).toBe(401);

    const wrongAgent = await app.inject({
      method: "POST",
      url: `/api/v1/agent/chats/${chatId}/messages`,
      headers: {
        authorization: `Bearer ${outbox.accessToken}`,
        "x-agent-id": recipient.agent.uuid,
      },
      payload: {
        format: "text",
        content: "Wrong sender.",
        metadata: { mentions: [sender.agent.uuid] },
        source: "cli",
      },
    });
    expect(wrongAgent.statusCode).toBe(401);
  });

  it("rejects stale runtime session tokens after DB revocation", async () => {
    const app = getApp();
    const { agent, clientId, accessToken } = await createTestAgent(app);
    const runtimeSessionToken = await bindAgentRuntimeSession(app.db, agent.uuid, clientId);
    await revokeAgentRuntimeSession(app.db, agent.uuid, clientId);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/agent/me",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "x-agent-id": agent.uuid,
        [AGENT_RUNTIME_SESSION_HEADER]: runtimeSessionToken,
      },
    });

    expect(res.statusCode).toBe(403);
  });

  it("does not require runtime session tokens for human agents", async () => {
    const app = getApp();
    const { agent, accessToken } = await createTestAgent(app, { type: "human" });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/agent/me",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "x-agent-id": agent.uuid,
      },
    });

    expect(res.statusCode).toBe(200);
  });
});
