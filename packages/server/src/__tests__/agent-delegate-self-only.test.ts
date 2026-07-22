import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

/**
 * Route-layer authorization: `delegateMention` is a personal choice, so only
 * the member themselves may set/change/clear their own delegate. An admin
 * managing the org must NOT be able to set a delegate on another member's
 * human agent — even though `requireAgentAccess(..., "manage")` otherwise lets
 * an admin manage any agent in the org.
 *
 * Two `createTestAdmin` calls land in the same default org, so admin A acting
 * on admin B's human agent is the exact "admin sets someone else's delegate"
 * scenario.
 */
describe("PATCH /agents/:uuid — delegateMention is self-only", () => {
  const getApp = useTestApp();

  it("rejects an admin setting another member's delegateMention (403)", async () => {
    const app = getApp();
    const a = await createTestAdmin(app);
    const b = await createTestAdmin(app);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/agents/${b.humanAgentUuid}`,
      headers: { authorization: `Bearer ${a.accessToken}` },
      payload: { delegateMention: randomUUID() },
    });

    expect(res.statusCode).toBe(403);
  });

  it("rejects an admin clearing another member's delegateMention (403)", async () => {
    const app = getApp();
    const a = await createTestAdmin(app);
    const b = await createTestAdmin(app);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/agents/${b.humanAgentUuid}`,
      headers: { authorization: `Bearer ${a.accessToken}` },
      payload: { delegateMention: null },
    });

    expect(res.statusCode).toBe(403);
  });

  it("allows a member setting their own delegateMention (200)", async () => {
    const app = getApp();
    const b = await createTestAdmin(app);

    const targetUuid = randomUUID();
    await app.db.insert(agents).values({
      uuid: targetUuid,
      name: `tgt-${randomUUID().slice(0, 6)}`,
      organizationId: b.organizationId,
      type: "agent",
      displayName: "Target",
      inboxId: `inbox_${targetUuid}`,
      managerId: b.memberId,
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/agents/${b.humanAgentUuid}`,
      headers: { authorization: `Bearer ${b.accessToken}` },
      payload: { delegateMention: targetUuid },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().delegateMention).toBe(targetUuid);
  });

  it("still lets an admin edit another member's non-identity fields (200)", async () => {
    const app = getApp();
    const a = await createTestAdmin(app);
    const b = await createTestAdmin(app);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/agents/${b.humanAgentUuid}`,
      headers: { authorization: `Bearer ${a.accessToken}` },
      payload: { avatarColorToken: "hue-3" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().avatarColorToken).toBe("hue-3");
  });
});
