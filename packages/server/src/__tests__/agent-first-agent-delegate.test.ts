import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { createAgent, updateAgent } from "../services/agent.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

/**
 * First-agent → delegate adoption (createAgent).
 *
 * A member's FIRST non-human agent is auto-adopted as their delegate
 * (`delegateMention` on their human agent), so the new-chat default recipient
 * and the GitHub @mention forward target work out of the box with no manual
 * trip to the profile editor. The adoption is only-if-unset and
 * first-agent-only, and never fires on the system/webhook agent path (which
 * supplies no caller `managerId`). Companion to the source-type and cross-org
 * delegate guards.
 */
async function readDelegate(
  app: ReturnType<ReturnType<typeof useTestApp>>,
  humanAgentUuid: string,
): Promise<string | null> {
  const [row] = await app.db
    .select({ delegateMention: agents.delegateMention })
    .from(agents)
    .where(eq(agents.uuid, humanAgentUuid))
    .limit(1);
  return row?.delegateMention ?? null;
}

describe("agent service — first-agent delegate adoption", () => {
  const getApp = useTestApp();

  it("adopts a member's first agent as their delegate", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    expect(await readDelegate(app, admin.humanAgentUuid)).toBeNull();

    const first = await createAgent(app.db, {
      name: `a1-${randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "First",
      managerId: admin.memberId,
    });

    expect(await readDelegate(app, admin.humanAgentUuid)).toBe(first.uuid);
  });

  it("adopts a private first agent (visibility is not required)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    const first = await createAgent(app.db, {
      name: `pa-${randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Private assistant",
      visibility: "private",
      managerId: admin.memberId,
    });

    expect(first.visibility).toBe("private");
    expect(await readDelegate(app, admin.humanAgentUuid)).toBe(first.uuid);
  });

  it("does not change the delegate when a second agent is created", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const first = await createAgent(app.db, {
      name: `a1-${randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "First",
      managerId: admin.memberId,
    });
    const second = await createAgent(app.db, {
      name: `a2-${randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Second",
      managerId: admin.memberId,
    });

    expect(second.uuid).not.toBe(first.uuid);
    expect(await readDelegate(app, admin.humanAgentUuid)).toBe(first.uuid);
  });

  it("does not overwrite a delegate already set before the member's first own agent", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    // A second member in the same org owns the pre-set target, so it does not
    // count toward `admin`'s own-agent tally (which keeps the first-agent count
    // at 1 below — isolating the only-if-unset guard from the count guard).
    const other = await createTestAdmin(app);
    const target = await createAgent(app.db, {
      name: `tgt-${randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Pre-set target",
      visibility: "organization",
      managerId: other.memberId,
    });
    await updateAgent(app.db, admin.humanAgentUuid, { delegateMention: target.uuid });

    // admin's OWN first agent — tally is 1, but the delegate is already set.
    await createAgent(app.db, {
      name: `a1-${randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "First own",
      managerId: admin.memberId,
    });

    expect(await readDelegate(app, admin.humanAgentUuid)).toBe(target.uuid);
  });

  it("does not adopt on the system/webhook path (no caller managerId)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    // Branch 3: with no `managerId`, the manager resolves to the org's admin,
    // but the adoption guard requires a caller-supplied `managerId`, so it
    // no-ops and a webhook-spawned agent never hijacks the admin's delegate.
    await createAgent(app.db, {
      name: `sys-${randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "System",
      organizationId: admin.organizationId,
    });

    expect(await readDelegate(app, admin.humanAgentUuid)).toBeNull();
  });
});
