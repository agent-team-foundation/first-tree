import { describe, expect, it } from "vitest";
import { createTestAgent, useTestApp } from "./helpers.js";

/**
 * Unified-user-token T6 (proposal M7 / Q4): `agents.client_id` is immutable
 * once set. PATCH /admin/agents/:uuid { clientId } must reject with 400 so
 * operators are told the field cannot move, instead of silently dropping the
 * field (the schema-only approach).
 */
describe("PATCH /admin/agents/:uuid { clientId } — immutable", () => {
  const getApp = useTestApp();

  it("returns 400 when clientId is present in the body", async () => {
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
