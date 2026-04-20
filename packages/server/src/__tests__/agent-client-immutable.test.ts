import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { createTestAgent, useTestApp } from "./helpers.js";

/**
 * `agents.client_id` is one-shot:
 *   - NULL → ID is allowed (admin claims an unbound agent for a known client).
 *   - ID → another ID is rejected (would orphan the running runtime).
 *   - ID → null is rejected (no point exposing an unbind path).
 */
describe("PATCH /admin/agents/:uuid { clientId } — one-shot", () => {
  const getApp = useTestApp();

  it("returns 400 when changing an already-set clientId", async () => {
    const app = getApp();
    const { agent, accessToken } = await createTestAgent(app, { name: `imm-${Date.now()}` });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/agents/${agent.uuid}`,
      headers: { Authorization: `Bearer ${accessToken}` },
      payload: { clientId: "another-client-id" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toMatch(/immutable/i);
  });

  it("returns 400 when clearing clientId to null", async () => {
    const app = getApp();
    const { agent, accessToken } = await createTestAgent(app, { name: `clr-${Date.now()}` });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/agents/${agent.uuid}`,
      headers: { Authorization: `Bearer ${accessToken}` },
      payload: { clientId: null },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toMatch(/cannot be cleared/i);
  });

  it("accepts NULL → ID first-set when the client is owned by the manager", async () => {
    const app = getApp();
    const { agent, accessToken, clientId } = await createTestAgent(app, { name: `set-${Date.now()}` });
    // Detach the agent so the row matches the post-migration "unclaimed" shape.
    await app.db.update(agents).set({ clientId: null }).where(eq(agents.uuid, agent.uuid));

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/agents/${agent.uuid}`,
      headers: { Authorization: `Bearer ${accessToken}` },
      payload: { clientId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ clientId: string }>().clientId).toBe(clientId);
  });

  it("still accepts legitimate updates (e.g. displayName) without side-effects on clientId", async () => {
    const app = getApp();
    const { agent, accessToken, clientId } = await createTestAgent(app, { name: `imm-ok-${Date.now()}` });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/agents/${agent.uuid}`,
      headers: { Authorization: `Bearer ${accessToken}` },
      payload: { displayName: "Renamed" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ displayName: string; clientId: string }>();
    expect(body.displayName).toBe("Renamed");
    expect(body.clientId).toBe(clientId);
  });
});
