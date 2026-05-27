import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { BadRequestError } from "../errors.js";
import { createAgent, updateAgent } from "../services/agent.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

/**
 * Service-layer guard: only `human` agents can carry `delegateMention`.
 *
 * The Web UI already gates the field on `agent.type === "human"`
 * (`identity-section.tsx:127, 211`), but the server service used to allow
 * any type. Without this guard, CLI / Admin API / scripts could set
 * delegateMention on a non-human `agent` row (formerly `personal_assistant`
 * / `autonomous_agent`) and the audience resolver would happily fan
 * webhook events out from it — accidentally re-enabling the
 * autonomous-agent-self-mention path that resolveAudience's `kind: "new"`
 * branch leaves wide open.
 *
 * Companion to `agent-delegate-mention-cross-org.test.ts` which pins the
 * target-side guards (cross-org, not-found).
 */
async function seedTargetHuman(
  app: ReturnType<ReturnType<typeof useTestApp>>,
  orgId: string,
  managerId: string,
): Promise<string> {
  const uuid = randomUUID();
  await app.db.insert(agents).values({
    uuid,
    name: `tgt-${randomUUID().slice(0, 6)}`,
    organizationId: orgId,
    type: "human",
    displayName: "Target",
    inboxId: `inbox_${uuid}`,
    managerId,
  });
  return uuid;
}

describe("agent service — delegateMention source-type guard", () => {
  const getApp = useTestApp();

  it("createAgent rejects delegateMention on a non-human (agent) source", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const target = await seedTargetHuman(app, admin.organizationId, admin.memberId);

    await expect(
      createAgent(app.db, {
        name: `src-${randomUUID().slice(0, 6)}`,
        type: "agent",
        displayName: "Source",
        managerId: admin.memberId,
        delegateMention: target,
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("createAgent allows omitting delegateMention on a non-human source", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    const created = await createAgent(app.db, {
      name: `src-${randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Source",
      managerId: admin.memberId,
    });
    expect(created.delegateMention).toBeNull();
  });

  it("updateAgent rejects setting delegateMention on a non-human source", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const target = await seedTargetHuman(app, admin.organizationId, admin.memberId);
    const nonHumanUuid = randomUUID();
    await app.db.insert(agents).values({
      uuid: nonHumanUuid,
      name: `bot-${randomUUID().slice(0, 6)}`,
      organizationId: admin.organizationId,
      type: "agent",
      displayName: "Bot",
      inboxId: `inbox_${nonHumanUuid}`,
      managerId: admin.memberId,
    });

    await expect(updateAgent(app.db, nonHumanUuid, { delegateMention: target })).rejects.toBeInstanceOf(
      BadRequestError,
    );
  });

  it("updateAgent allows clearing delegateMention on any type (null write skips the type guard)", async () => {
    // Allowing null on any type lets ops scrub bad data without first
    // changing the agent's type — the guard targets *setting* a non-null
    // value on a non-human row, not *clearing*.
    const app = getApp();
    const admin = await createTestAdmin(app);
    const nonHumanUuid = randomUUID();
    await app.db.insert(agents).values({
      uuid: nonHumanUuid,
      name: `bot-${randomUUID().slice(0, 6)}`,
      organizationId: admin.organizationId,
      type: "agent",
      displayName: "Bot",
      inboxId: `inbox_${nonHumanUuid}`,
      managerId: admin.memberId,
    });

    const updated = await updateAgent(app.db, nonHumanUuid, { delegateMention: null });
    expect(updated.delegateMention).toBeNull();
  });

  it("updateAgent honors a same-patch type → human flip alongside delegateMention", async () => {
    // Same-patch type change must apply before the guard reads it, otherwise
    // an admin promoting a row to human and setting its delegate in one
    // PATCH would 400 even though the post-patch state is valid.
    const app = getApp();
    const admin = await createTestAdmin(app);
    const target = await seedTargetHuman(app, admin.organizationId, admin.memberId);
    const sourceUuid = randomUUID();
    await app.db.insert(agents).values({
      uuid: sourceUuid,
      name: `src-${randomUUID().slice(0, 6)}`,
      organizationId: admin.organizationId,
      type: "agent",
      displayName: "Source",
      inboxId: `inbox_${sourceUuid}`,
      managerId: admin.memberId,
    });

    const updated = await updateAgent(app.db, sourceUuid, {
      type: "human",
      delegateMention: target,
    });
    expect(updated.type).toBe("human");
    expect(updated.delegateMention).toBe(target);
  });

  it("updateAgent rejects when a same-patch type flip targets a non-human type alongside delegateMention", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const target = await seedTargetHuman(app, admin.organizationId, admin.memberId);

    await expect(
      updateAgent(app.db, admin.humanAgentUuid, {
        type: "agent",
        delegateMention: target,
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("updateAgent rejects flipping type away from human when delegateMention is set (no same-patch clear)", async () => {
    // The type-flip leak: without a guard on the `type` write itself,
    // `{type: "agent"}` alone (no delegateMention field) would
    // silently leave behind a non-human row carrying a delegate uuid —
    // violating the invariant the source-type guard is meant to enforce.
    const app = getApp();
    const admin = await createTestAdmin(app);
    const target = await seedTargetHuman(app, admin.organizationId, admin.memberId);
    // Seed a human source with delegateMention set.
    await updateAgent(app.db, admin.humanAgentUuid, { delegateMention: target });

    await expect(updateAgent(app.db, admin.humanAgentUuid, { type: "agent" })).rejects.toBeInstanceOf(BadRequestError);
  });

  it("updateAgent accepts flipping type away from human when the same patch clears delegateMention", async () => {
    // Companion to the leak guard above: the patch is well-formed when it
    // clears the field in the same write. This is the ops-side recovery
    // path — change the agent's role and scrub the delegate together.
    const app = getApp();
    const admin = await createTestAdmin(app);
    const target = await seedTargetHuman(app, admin.organizationId, admin.memberId);
    await updateAgent(app.db, admin.humanAgentUuid, { delegateMention: target });

    const updated = await updateAgent(app.db, admin.humanAgentUuid, {
      type: "agent",
      delegateMention: null,
    });
    expect(updated.type).toBe("agent");
    expect(updated.delegateMention).toBeNull();
  });
});
