import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { listOrgsWithPersonalAgent, listOrgsWithUsableNonHumanAgent } from "../services/access-control.js";
import { ensureMembership } from "../services/membership.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

/**
 * Direct-insert an agent row, bypassing the createAgent service ceremony
 * (client pinning, quota, agent_configs) — the readiness helper only reads
 * the `agents` table, so a plain row is enough to exercise its predicate.
 */
async function insertAgent(
  db: Database,
  opts: {
    orgId: string;
    managerId: string;
    visibility: "private" | "organization";
    status?: "active" | "suspended" | "deleted";
    type?: "agent" | "human";
  },
): Promise<void> {
  const uuid = crypto.randomUUID();
  await db.insert(agents).values({
    uuid,
    name: `a-${uuid.slice(0, 8)}`,
    organizationId: opts.orgId,
    type: opts.type ?? "agent",
    displayName: "Fixture Agent",
    inboxId: `inbox_${uuid}`,
    status: opts.status ?? "active",
    visibility: opts.visibility,
    managerId: opts.managerId,
  });
}

describe("listOrgsWithUsableNonHumanAgent", () => {
  const getApp = useTestApp();

  it("an org with only the seeded human agent is NOT ready", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const set = await listOrgsWithUsableNonHumanAgent(app.db, [
      { memberId: admin.memberId, organizationId: admin.organizationId },
    ]);
    // The human agent ensureMembership seeds is org-visible but type=human,
    // so it must be excluded — a brand-new team is not "ready".
    expect(set.has(admin.organizationId)).toBe(false);
  });

  it("my own active non-human agent makes the org ready — even when private", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await insertAgent(app.db, { orgId: admin.organizationId, managerId: admin.memberId, visibility: "private" });
    const set = await listOrgsWithUsableNonHumanAgent(app.db, [
      { memberId: admin.memberId, organizationId: admin.organizationId },
    ]);
    expect(set.has(admin.organizationId)).toBe(true);
  });

  it("a suspended or deleted own agent does NOT count", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await insertAgent(app.db, {
      orgId: admin.organizationId,
      managerId: admin.memberId,
      visibility: "organization",
      status: "suspended",
    });
    await insertAgent(app.db, {
      orgId: admin.organizationId,
      managerId: admin.memberId,
      visibility: "organization",
      status: "deleted",
    });
    const set = await listOrgsWithUsableNonHumanAgent(app.db, [
      { memberId: admin.memberId, organizationId: admin.organizationId },
    ]);
    expect(set.has(admin.organizationId)).toBe(false);
  });

  it("another member's ORGANIZATION-visible agent counts for me (shared mature org)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const other = await createTestAdmin(app); // just to mint a second user
    const memberB = await ensureMembership(app.db, {
      userId: other.userId,
      organizationId: admin.organizationId,
      role: "member",
      displayName: "Member B",
      username: `b-${crypto.randomUUID().slice(0, 6)}`,
    });
    await insertAgent(app.db, { orgId: admin.organizationId, managerId: memberB.id, visibility: "organization" });
    const set = await listOrgsWithUsableNonHumanAgent(app.db, [
      { memberId: admin.memberId, organizationId: admin.organizationId },
    ]);
    expect(set.has(admin.organizationId)).toBe(true);
  });

  it("another member's PRIVATE agent does NOT count for me (all-private org is not ready)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const other = await createTestAdmin(app);
    const memberB = await ensureMembership(app.db, {
      userId: other.userId,
      organizationId: admin.organizationId,
      role: "member",
      displayName: "Member B",
      username: `b-${crypto.randomUUID().slice(0, 6)}`,
    });
    await insertAgent(app.db, { orgId: admin.organizationId, managerId: memberB.id, visibility: "private" });
    const set = await listOrgsWithUsableNonHumanAgent(app.db, [
      { memberId: admin.memberId, organizationId: admin.organizationId },
    ]);
    expect(set.has(admin.organizationId)).toBe(false);
  });

  it("returns an empty set for a caller with no memberships (no query)", async () => {
    const app = getApp();
    const set = await listOrgsWithUsableNonHumanAgent(app.db, []);
    expect(set.size).toBe(0);
  });
});

describe("listOrgsWithPersonalAgent", () => {
  const getApp = useTestApp();

  it("counts only active non-human agents managed by the current membership", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const set = await listOrgsWithPersonalAgent(app.db, [
      { memberId: admin.memberId, organizationId: admin.organizationId },
    ]);
    expect(set.has(admin.organizationId)).toBe(false);

    await insertAgent(app.db, { orgId: admin.organizationId, managerId: admin.memberId, visibility: "private" });
    const afterOwnAgent = await listOrgsWithPersonalAgent(app.db, [
      { memberId: admin.memberId, organizationId: admin.organizationId },
    ]);
    expect(afterOwnAgent.has(admin.organizationId)).toBe(true);
  });

  it("does NOT count another member's organization-visible agent", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const other = await createTestAdmin(app);
    const memberB = await ensureMembership(app.db, {
      userId: other.userId,
      organizationId: admin.organizationId,
      role: "member",
      displayName: "Member B",
      username: `b-${crypto.randomUUID().slice(0, 6)}`,
    });
    await insertAgent(app.db, { orgId: admin.organizationId, managerId: memberB.id, visibility: "organization" });

    const usable = await listOrgsWithUsableNonHumanAgent(app.db, [
      { memberId: admin.memberId, organizationId: admin.organizationId },
    ]);
    expect(usable.has(admin.organizationId)).toBe(true);

    const personal = await listOrgsWithPersonalAgent(app.db, [
      { memberId: admin.memberId, organizationId: admin.organizationId },
    ]);
    expect(personal.has(admin.organizationId)).toBe(false);
  });
});
