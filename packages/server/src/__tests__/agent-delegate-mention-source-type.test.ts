import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
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
  const unsafeUpdate = (data: unknown): Parameters<typeof updateAgent>[2] => data as Parameters<typeof updateAgent>[2];

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

  it("updateAgent rejects promoting a non-human row to human alongside delegateMention", async () => {
    // `type` is immutable after create; human mirrors are owned by member
    // lifecycle, not by the generic agent patch path. Cast through the service
    // type to simulate an internal caller that bypasses the public schema.
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

    await expect(
      updateAgent(
        app.db,
        sourceUuid,
        unsafeUpdate({
          type: "human",
          delegateMention: target,
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("updateAgent rejects demoting a human row even when the same patch clears delegateMention", async () => {
    // This is the human-mirror lifecycle guard: allowing `{ type: "agent" }`
    // would let a caller bypass direct human suspend/delete protection.
    const app = getApp();
    const admin = await createTestAdmin(app);
    const target = await seedTargetHuman(app, admin.organizationId, admin.memberId);
    await updateAgent(app.db, admin.humanAgentUuid, { delegateMention: target });

    await expect(
      updateAgent(
        app.db,
        admin.humanAgentUuid,
        unsafeUpdate({
          type: "agent",
          delegateMention: null,
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestError);

    const [row] = await app.db
      .select({ type: agents.type, delegateMention: agents.delegateMention })
      .from(agents)
      .where(eq(agents.uuid, admin.humanAgentUuid))
      .limit(1);
    expect(row).toEqual({
      type: "human",
      delegateMention: target,
    });
  });

  it("updateAgent rejects demoting a human row without a same-patch delegate clear", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const target = await seedTargetHuman(app, admin.organizationId, admin.memberId);
    await updateAgent(app.db, admin.humanAgentUuid, { delegateMention: target });

    await expect(
      updateAgent(
        app.db,
        admin.humanAgentUuid,
        unsafeUpdate({
          type: "agent",
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("updateAgent rejects demoting a human row alongside a new delegateMention", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const target = await seedTargetHuman(app, admin.organizationId, admin.memberId);

    await expect(
      updateAgent(
        app.db,
        admin.humanAgentUuid,
        unsafeUpdate({
          type: "agent",
          delegateMention: target,
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestError);
  });
});
