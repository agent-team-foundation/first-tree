import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { organizations } from "../db/schema/organizations.js";
import { BadRequestError } from "../errors.js";
import { createAgent, updateAgent } from "../services/agent.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

/**
 * Service-layer guards on `delegateMention` writes (plan A).
 *
 * The audience resolver (plan B in services/github-audience.ts) already filters
 * cross-org delegate targets at fan-out time. These tests pin down the
 * source-side guard so the column can never accumulate dangling or cross-org
 * uuids in the first place — keeping the data clean and giving admins an
 * immediate 422 instead of a silent runtime drop.
 */
async function makeForeignOrgAgent(
  app: ReturnType<ReturnType<typeof useTestApp>>,
  label: string,
  fallbackManagerId: string,
): Promise<{ orgId: string; agentUuid: string }> {
  const orgId = `org-${label}-${randomUUID().slice(0, 6)}`;
  await app.db.insert(organizations).values({
    id: orgId,
    name: orgId.slice(0, 30),
    displayName: `Org ${label}`,
  });
  const agentUuid = randomUUID();
  await app.db.insert(agents).values({
    uuid: agentUuid,
    name: `bot-${label}-${randomUUID().slice(0, 6)}`,
    organizationId: orgId,
    type: "autonomous_agent",
    displayName: `Bot ${label}`,
    inboxId: `inbox_${agentUuid}`,
    managerId: fallbackManagerId,
  });
  return { orgId, agentUuid };
}

describe("agent service — delegateMention cross-org guard", () => {
  const getApp = useTestApp();

  it("createAgent rejects a cross-org delegateMention target", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const foreign = await makeForeignOrgAgent(app, "x", admin.memberId);

    await expect(
      createAgent(app.db, {
        name: `src-${randomUUID().slice(0, 6)}`,
        type: "human",
        displayName: "Source",
        managerId: admin.memberId,
        delegateMention: foreign.agentUuid,
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("createAgent rejects a delegateMention target that does not exist", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    await expect(
      createAgent(app.db, {
        name: `src-${randomUUID().slice(0, 6)}`,
        type: "human",
        displayName: "Source",
        managerId: admin.memberId,
        delegateMention: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("createAgent accepts a same-org delegateMention target", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    const targetUuid = randomUUID();
    await app.db.insert(agents).values({
      uuid: targetUuid,
      name: `tgt-${randomUUID().slice(0, 6)}`,
      organizationId: admin.organizationId,
      type: "autonomous_agent",
      displayName: "Target",
      inboxId: `inbox_${targetUuid}`,
      managerId: admin.memberId,
    });

    const created = await createAgent(app.db, {
      name: `src-${randomUUID().slice(0, 6)}`,
      type: "human",
      displayName: "Source",
      managerId: admin.memberId,
      delegateMention: targetUuid,
    });
    expect(created.delegateMention).toBe(targetUuid);
  });

  it("updateAgent rejects switching delegateMention to a cross-org target", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const foreign = await makeForeignOrgAgent(app, "x", admin.memberId);

    await expect(
      updateAgent(app.db, admin.humanAgentUuid, { delegateMention: foreign.agentUuid }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("updateAgent allows clearing delegateMention (null) without target lookup", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    const updated = await updateAgent(app.db, admin.humanAgentUuid, { delegateMention: null });
    expect(updated.delegateMention).toBeNull();
  });

  it("updateAgent accepts a same-org delegateMention target", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    const targetUuid = randomUUID();
    await app.db.insert(agents).values({
      uuid: targetUuid,
      name: `tgt-${randomUUID().slice(0, 6)}`,
      organizationId: admin.organizationId,
      type: "autonomous_agent",
      displayName: "Target",
      inboxId: `inbox_${targetUuid}`,
      managerId: admin.memberId,
    });

    const updated = await updateAgent(app.db, admin.humanAgentUuid, { delegateMention: targetUuid });
    expect(updated.delegateMention).toBe(targetUuid);
  });
});
