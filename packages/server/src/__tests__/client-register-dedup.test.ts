import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { clients } from "../db/schema/clients.js";
import { members } from "../db/schema/members.js";
import { createAgent } from "../services/agent.js";
import { ClientDedupConflictError, registerClient } from "../services/client.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

/**
 * Soft-dedup tests for `registerClient`.
 *
 * The dedup branch runs only when the caller's `clientId` is brand new (no
 * row for that id yet) AND `hostname` + `os` are both present. It looks for
 * a canonical `(user_id, hostname, os)` row and, when one exists, merges the
 * new connection's runtime info onto that row instead of inserting a new
 * one — preventing the orphan-row accumulation seen in production before
 * PR-C.
 *
 * Coordination invariants tested here:
 *   - Empty candidate set → plain INSERT (no dedup).
 *   - Existing canonical (disconnected) → redirect-merge, original id wins.
 *   - Existing canonical (connected) + the slot is held by a different live
 *     socket → `ClientDedupConflictError` (refuse to steal).
 *   - Caller's id already exists → existing same-id upsert path; dedup
 *     query never runs.
 *   - Missing hostname/os → no dedup (we need a stable anchor to merge).
 *   - Archived canonical → still wins as canonical, and the merge clears
 *     `archived_at` (unarchive on return).
 */
describe("registerClient — soft dedup", () => {
  const getApp = useTestApp();

  it("returns canonicalClientId = caller's id + redirected=false when no canonical exists", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `nope-${crypto.randomUUID().slice(0, 8)}` });

    const clientId = `cli-${crypto.randomUUID().slice(0, 8)}`;
    const result = await registerClient(app.db, {
      clientId,
      userId: admin.userId,
      organizationId: admin.organizationId,
      instanceId: "test-instance",
      hostname: "MacBook-Pro.local",
      os: "darwin",
    });

    expect(result).toEqual({ canonicalClientId: clientId, redirected: false });
    const [row] = await app.db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
    expect(row?.id).toBe(clientId);
    expect(row?.status).toBe("connected");
  });

  it("redirects to canonical when a disconnected (user, host, os) row already exists", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `dup-${crypto.randomUUID().slice(0, 8)}` });

    const oldId = `cli-old-${crypto.randomUUID().slice(0, 8)}`;
    await app.db.insert(clients).values({
      id: oldId,
      userId: admin.userId,
      organizationId: admin.organizationId,
      status: "disconnected",
      hostname: "MacBook-Pro.local",
      os: "darwin",
      lastSeenAt: new Date(Date.now() - 60_000),
    });

    const newId = `cli-new-${crypto.randomUUID().slice(0, 8)}`;
    const result = await registerClient(app.db, {
      clientId: newId,
      userId: admin.userId,
      organizationId: admin.organizationId,
      instanceId: "test-instance-2",
      hostname: "MacBook-Pro.local",
      os: "darwin",
      sdkVersion: "0.5.2-alpha.30",
    });

    expect(result.redirected).toBe(true);
    expect(result.canonicalClientId).toBe(oldId);

    // Old row absorbed the new connection info.
    const [merged] = await app.db.select().from(clients).where(eq(clients.id, oldId)).limit(1);
    expect(merged?.status).toBe("connected");
    expect(merged?.sdkVersion).toBe("0.5.2-alpha.30");
    expect(merged?.instanceId).toBe("test-instance-2");

    // The new id was never inserted as a fresh row.
    const newRow = await app.db.select().from(clients).where(eq(clients.id, newId)).limit(1);
    expect(newRow).toEqual([]);
  });

  it("falls back to plain INSERT when hostname is missing (no safe anchor for dedup)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `nohost-${crypto.randomUUID().slice(0, 8)}` });

    // Pre-seed a row with NULL hostname to make sure we don't accidentally
    // match across NULL anchors (which would over-merge unrelated rows).
    const existingId = `cli-exist-${crypto.randomUUID().slice(0, 8)}`;
    await app.db.insert(clients).values({
      id: existingId,
      userId: admin.userId,
      organizationId: admin.organizationId,
      status: "disconnected",
      hostname: null,
      os: null,
    });

    const newId = `cli-anon-${crypto.randomUUID().slice(0, 8)}`;
    const result = await registerClient(app.db, {
      clientId: newId,
      userId: admin.userId,
      organizationId: admin.organizationId,
      instanceId: "test-instance",
      // hostname/os intentionally omitted
    });

    expect(result.redirected).toBe(false);
    expect(result.canonicalClientId).toBe(newId);

    // Both rows live independently when there's no anchor to merge on.
    const [newRow] = await app.db.select().from(clients).where(eq(clients.id, newId)).limit(1);
    expect(newRow?.id).toBe(newId);
  });

  it("same-id reconnect runs the existing upsert path with no dedup query", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `same-${crypto.randomUUID().slice(0, 8)}` });

    const clientId = `cli-same-${crypto.randomUUID().slice(0, 8)}`;
    await registerClient(app.db, {
      clientId,
      userId: admin.userId,
      organizationId: admin.organizationId,
      instanceId: "first",
      hostname: "MacBook-Pro.local",
      os: "darwin",
    });

    const result = await registerClient(app.db, {
      clientId,
      userId: admin.userId,
      organizationId: admin.organizationId,
      instanceId: "second",
      hostname: "MacBook-Pro.local",
      os: "darwin",
    });

    expect(result).toEqual({ canonicalClientId: clientId, redirected: false });
    const [row] = await app.db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
    expect(row?.instanceId).toBe("second");
  });

  it("throws ClientDedupConflictError when the canonical slot is held by a different live socket", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `conflict-${crypto.randomUUID().slice(0, 8)}` });

    const liveId = `cli-live-${crypto.randomUUID().slice(0, 8)}`;
    await app.db.insert(clients).values({
      id: liveId,
      userId: admin.userId,
      organizationId: admin.organizationId,
      status: "connected",
      hostname: "MacBook-Pro.local",
      os: "darwin",
    });

    const newId = `cli-new-${crypto.randomUUID().slice(0, 8)}`;
    await expect(
      registerClient(
        app.db,
        {
          clientId: newId,
          userId: admin.userId,
          organizationId: admin.organizationId,
          instanceId: "test-instance",
          hostname: "MacBook-Pro.local",
          os: "darwin",
        },
        () => true, // simulate "canonical slot is held by another live socket"
      ),
    ).rejects.toBeInstanceOf(ClientDedupConflictError);

    // The live canonical row was NOT mutated.
    const [unchanged] = await app.db.select().from(clients).where(eq(clients.id, liveId)).limit(1);
    expect(unchanged?.instanceId).toBeNull();

    // New id was NOT inserted.
    const newRow = await app.db.select().from(clients).where(eq(clients.id, newId)).limit(1);
    expect(newRow).toEqual([]);
  });

  it("unarchives the canonical row when dedup picks an archived candidate", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `unarch-${crypto.randomUUID().slice(0, 8)}` });

    const oldId = `cli-arch-${crypto.randomUUID().slice(0, 8)}`;
    await app.db.insert(clients).values({
      id: oldId,
      userId: admin.userId,
      organizationId: admin.organizationId,
      status: "disconnected",
      hostname: "MacBook-Pro.local",
      os: "darwin",
      archivedAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
    });

    const newId = `cli-new-${crypto.randomUUID().slice(0, 8)}`;
    const result = await registerClient(app.db, {
      clientId: newId,
      userId: admin.userId,
      organizationId: admin.organizationId,
      instanceId: "test-instance",
      hostname: "MacBook-Pro.local",
      os: "darwin",
    });

    expect(result.redirected).toBe(true);
    expect(result.canonicalClientId).toBe(oldId);

    const [resurrected] = await app.db.select().from(clients).where(eq(clients.id, oldId)).limit(1);
    expect(resurrected?.archivedAt).toBeNull();
    expect(resurrected?.status).toBe("connected");
  });

  it("same-id reconnect of an archived row clears archived_at (unarchive on return)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `same-arch-${crypto.randomUUID().slice(0, 8)}` });

    const clientId = `cli-arch-same-${crypto.randomUUID().slice(0, 8)}`;
    await app.db.insert(clients).values({
      id: clientId,
      userId: admin.userId,
      organizationId: admin.organizationId,
      status: "disconnected",
      hostname: "MacBook-Pro.local",
      os: "darwin",
      archivedAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
    });

    const result = await registerClient(app.db, {
      clientId,
      userId: admin.userId,
      organizationId: admin.organizationId,
      instanceId: "test-instance",
      hostname: "MacBook-Pro.local",
      os: "darwin",
    });

    expect(result).toEqual({ canonicalClientId: clientId, redirected: false });
    const [row] = await app.db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
    expect(row?.archivedAt).toBeNull();
    expect(row?.status).toBe("connected");
  });

  it("prefers a canonical with pinned agents over one without (pickCanonical priority)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `priority-${crypto.randomUUID().slice(0, 8)}` });

    const idEmpty = `cli-empty-${crypto.randomUUID().slice(0, 8)}`;
    const idBusy = `cli-busy-${crypto.randomUUID().slice(0, 8)}`;
    await app.db.insert(clients).values([
      {
        id: idEmpty,
        userId: admin.userId,
        organizationId: admin.organizationId,
        status: "disconnected",
        hostname: "MacBook-Pro.local",
        os: "darwin",
        lastSeenAt: new Date(),
      },
      {
        id: idBusy,
        userId: admin.userId,
        organizationId: admin.organizationId,
        status: "disconnected",
        hostname: "MacBook-Pro.local",
        os: "darwin",
        lastSeenAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      },
    ]);

    // Pin an agent to idBusy so pickCanonical favors it despite the older
    // lastSeenAt — agentCount > lastSeenAt in the priority stack.
    const [adminMember] = await app.db
      .select({ id: members.id })
      .from(members)
      .where(and(eq(members.userId, admin.userId), eq(members.organizationId, admin.organizationId)))
      .limit(1);
    if (!adminMember) throw new Error("admin member missing");
    await createAgent(app.db, {
      name: `pinned-${crypto.randomUUID().slice(0, 8)}`,
      type: "autonomous_agent",
      displayName: "Pinned",
      managerId: adminMember.id,
      organizationId: admin.organizationId,
      clientId: idBusy,
      runtimeProvider: "claude-code",
    });

    const newId = `cli-new-${crypto.randomUUID().slice(0, 8)}`;
    const result = await registerClient(app.db, {
      clientId: newId,
      userId: admin.userId,
      organizationId: admin.organizationId,
      instanceId: "test-instance",
      hostname: "MacBook-Pro.local",
      os: "darwin",
    });

    expect(result.canonicalClientId).toBe(idBusy);
    expect(result.redirected).toBe(true);
  });
});
