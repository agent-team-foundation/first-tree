import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { clients } from "../db/schema/clients.js";
import { members } from "../db/schema/members.js";
import { createAgent } from "../services/agent.js";
import { archiveAbandonedClients, listClients } from "../services/client.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

/**
 * Orphan-row archival tests for `archiveAbandonedClients` + the read-path
 * filters that consume `archived_at`.
 *
 * The sweep archives a `clients` row when ALL of:
 *   - status = 'disconnected'
 *   - last_seen_at < NOW() - 30 days
 *   - zero non-deleted agents pinned
 *   - archived_at IS NULL (idempotency guard)
 *
 * 30 days is the locked-in product decision (2026-05-27). Tests pin the
 * threshold by manipulating `last_seen_at` to either side of the cutoff.
 */
describe("archiveAbandonedClients — sweep", () => {
  const getApp = useTestApp();

  const DAY_MS = 24 * 60 * 60 * 1000;

  it("archives a disconnected row with no agents and last_seen > 30 days ago", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `arch-${crypto.randomUUID().slice(0, 8)}` });

    const oldId = `cli-old-${crypto.randomUUID().slice(0, 8)}`;
    await app.db.insert(clients).values({
      id: oldId,
      userId: admin.userId,
      organizationId: admin.organizationId,
      status: "disconnected",
      hostname: "MacBook-Pro.local",
      os: "darwin",
      lastSeenAt: new Date(Date.now() - 31 * DAY_MS),
    });

    const archived = await archiveAbandonedClients(app.db);
    expect(archived).toBeGreaterThanOrEqual(1);
    const [row] = await app.db.select().from(clients).where(eq(clients.id, oldId)).limit(1);
    expect(row?.archivedAt).not.toBeNull();
  });

  it("does NOT archive a row that's only 29 days old (boundary)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `boundary-${crypto.randomUUID().slice(0, 8)}` });

    const id = `cli-young-${crypto.randomUUID().slice(0, 8)}`;
    await app.db.insert(clients).values({
      id,
      userId: admin.userId,
      organizationId: admin.organizationId,
      status: "disconnected",
      hostname: "MacBook-Pro.local",
      os: "darwin",
      lastSeenAt: new Date(Date.now() - 29 * DAY_MS),
    });

    await archiveAbandonedClients(app.db);
    const [row] = await app.db.select().from(clients).where(eq(clients.id, id)).limit(1);
    expect(row?.archivedAt).toBeNull();
  });

  it("does NOT archive a connected row even if last_seen is ancient (status guard)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `conn-${crypto.randomUUID().slice(0, 8)}` });

    const id = `cli-conn-${crypto.randomUUID().slice(0, 8)}`;
    await app.db.insert(clients).values({
      id,
      userId: admin.userId,
      organizationId: admin.organizationId,
      status: "connected",
      hostname: "MacBook-Pro.local",
      os: "darwin",
      lastSeenAt: new Date(Date.now() - 365 * DAY_MS),
    });

    await archiveAbandonedClients(app.db);
    const [row] = await app.db.select().from(clients).where(eq(clients.id, id)).limit(1);
    expect(row?.archivedAt).toBeNull();
  });

  it("does NOT archive a row with pinned agents even if it's stale", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `pinned-${crypto.randomUUID().slice(0, 8)}` });

    const id = `cli-pinned-${crypto.randomUUID().slice(0, 8)}`;
    await app.db.insert(clients).values({
      id,
      userId: admin.userId,
      organizationId: admin.organizationId,
      status: "disconnected",
      hostname: "MacBook-Pro.local",
      os: "darwin",
      lastSeenAt: new Date(Date.now() - 365 * DAY_MS),
    });
    const [adminMember] = await app.db
      .select({ id: members.id })
      .from(members)
      .where(eq(members.userId, admin.userId))
      .limit(1);
    if (!adminMember) throw new Error("admin member missing");
    await createAgent(app.db, {
      name: `pinned-${crypto.randomUUID().slice(0, 8)}`,
      type: "autonomous_agent",
      displayName: "Pinned",
      managerId: adminMember.id,
      organizationId: admin.organizationId,
      clientId: id,
      runtimeProvider: "claude-code",
    });

    await archiveAbandonedClients(app.db);
    const [row] = await app.db.select().from(clients).where(eq(clients.id, id)).limit(1);
    expect(row?.archivedAt).toBeNull();
  });

  it("is idempotent — re-running on an already-archived row is a no-op", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `idem-${crypto.randomUUID().slice(0, 8)}` });

    const id = `cli-already-${crypto.randomUUID().slice(0, 8)}`;
    const archivedAt = new Date(Date.now() - 10 * DAY_MS);
    await app.db.insert(clients).values({
      id,
      userId: admin.userId,
      organizationId: admin.organizationId,
      status: "disconnected",
      hostname: "MacBook-Pro.local",
      os: "darwin",
      lastSeenAt: new Date(Date.now() - 100 * DAY_MS),
      archivedAt,
    });

    const archived = await archiveAbandonedClients(app.db);
    // Doesn't matter how many other rows other tests created; what
    // matters is OUR row's archived_at didn't change.
    expect(archived).toBeGreaterThanOrEqual(0);
    const [row] = await app.db.select().from(clients).where(eq(clients.id, id)).limit(1);
    expect(row?.archivedAt?.toISOString()).toBe(archivedAt.toISOString());
  });
});

describe("read paths exclude archived rows", () => {
  const getApp = useTestApp();

  it("listClients omits archived rows from /me/clients results", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `listfilter-${crypto.randomUUID().slice(0, 8)}` });

    const activeId = `cli-active-${crypto.randomUUID().slice(0, 8)}`;
    const archivedId = `cli-arch-${crypto.randomUUID().slice(0, 8)}`;
    await app.db.insert(clients).values([
      {
        id: activeId,
        userId: admin.userId,
        organizationId: admin.organizationId,
        status: "connected",
        hostname: "host-a",
        os: "darwin",
      },
      {
        id: archivedId,
        userId: admin.userId,
        organizationId: admin.organizationId,
        status: "disconnected",
        hostname: "host-b",
        os: "darwin",
        archivedAt: new Date(),
      },
    ]);

    const list = await listClients(app.db, { userId: admin.userId });
    const ids = list.map((c) => c.id);
    expect(ids).toContain(activeId);
    expect(ids).not.toContain(archivedId);
  });
});
