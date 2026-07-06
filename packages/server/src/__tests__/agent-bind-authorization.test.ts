import { AGENT_RUNTIME_SESSION_HEADER } from "@first-tree/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { clients } from "../db/schema/clients.js";
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
