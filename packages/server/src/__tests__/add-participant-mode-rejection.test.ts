import { describe, expect, it } from "vitest";
import { createTestAgent, useTestApp } from "./helpers.js";

/**
 * `POST /api/v1/agent/chats/:chatId/participants` no longer accepts a `mode`
 * field. The route handler inspects the raw body and rejects with
 * `400 MODE_FIELD_DEPRECATED`. The shared `addParticipantSchema` also dropped
 * the field, so a stale TS caller that still constructs it would surface as
 * a compile-time error too — see `chat-participant-mode-fix-design.md` §3.2
 * and §6.
 */

describe("POST /api/v1/agent/chats/:chatId/participants — mode-field rejection", () => {
  const getApp = useTestApp();

  it("returns 400 with MODE_FIELD_DEPRECATED when the body contains `mode`", async () => {
    const app = getApp();
    const owner = await createTestAgent(app);
    const { agent: peer } = await createTestAgent(app);

    // Create a direct chat so we have a known chatId + the owner is a
    // participant (the route asserts that).
    const created = await owner.request("POST", "/api/v1/agent/chats", {
      type: "group",
      participantIds: [peer.uuid],
    });
    expect(created.statusCode).toBe(201);
    const chat = created.json() as { id: string };

    // Try to add a third participant while sending the deprecated field.
    const { agent: late } = await createTestAgent(app);
    const res = await owner.request("POST", `/api/v1/agent/chats/${chat.id}/participants`, {
      agentId: late.uuid,
      mode: "full",
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: expect.stringContaining("MODE_FIELD_DEPRECATED") });
  });

  it("accepts a body without `mode` and returns 201", async () => {
    const app = getApp();
    const owner = await createTestAgent(app);
    const { agent: peer } = await createTestAgent(app);

    const created = await owner.request("POST", "/api/v1/agent/chats", {
      type: "group",
      participantIds: [peer.uuid],
    });
    const chat = created.json() as { id: string };

    const { agent: late } = await createTestAgent(app);
    const res = await owner.request("POST", `/api/v1/agent/chats/${chat.id}/participants`, {
      agentId: late.uuid,
    });

    expect(res.statusCode).toBe(201);
  });
});
