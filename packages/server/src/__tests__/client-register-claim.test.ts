import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { clients } from "../db/schema/clients.js";
import { ForbiddenError } from "../errors.js";
import { registerClient } from "../services/client.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

/**
 * Unified-user-token T4 (M13): legacy clients inserted before handshake auth
 * landed carry `user_id = NULL`. When an authenticated operator first
 * re-registers that client_id, the row is *claimed* and the user_id filled in.
 * A different user trying to claim the same client_id is rejected as a
 * conflict — never silently overwritten, because pinned agents still belong
 * to whoever owned the original row.
 */
describe("registerClient — legacy user_id NULL claim + conflict rejection", () => {
  const getApp = useTestApp();

  it("claims a legacy row (user_id NULL) under the authenticated user", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `claim-${crypto.randomUUID().slice(0, 8)}` });

    const clientId = `legacy-${crypto.randomUUID().slice(0, 8)}`;
    // Simulate a legacy pre-handshake-auth row.
    await app.db.insert(clients).values({ id: clientId, userId: null, status: "disconnected" });

    await registerClient(app.db, {
      clientId,
      userId: admin.userId,
      instanceId: "test-instance",
      hostname: "host-1",
      os: "darwin",
      sdkVersion: "0.1.0",
    });

    const [row] = await app.db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
    expect(row?.userId).toBe(admin.userId);
    expect(row?.status).toBe("connected");
  });

  it("rejects a register attempt by a different user on an already-claimed client", async () => {
    const app = getApp();
    const alice = await createTestAdmin(app, { username: `alice-${crypto.randomUUID().slice(0, 8)}` });
    const bob = await createTestAdmin(app, { username: `bob-${crypto.randomUUID().slice(0, 8)}` });

    const clientId = `shared-${crypto.randomUUID().slice(0, 8)}`;
    await registerClient(app.db, { clientId, userId: alice.userId, instanceId: "test-instance" });

    await expect(
      registerClient(app.db, { clientId, userId: bob.userId, instanceId: "test-instance" }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    // Owner unchanged.
    const [row] = await app.db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
    expect(row?.userId).toBe(alice.userId);
  });

  it("is idempotent when the same user re-registers (no-op on ownership)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `idem-${crypto.randomUUID().slice(0, 8)}` });

    const clientId = `idem-${crypto.randomUUID().slice(0, 8)}`;
    await registerClient(app.db, { clientId, userId: admin.userId, instanceId: "i1", hostname: "h1" });
    await registerClient(app.db, { clientId, userId: admin.userId, instanceId: "i2", hostname: "h2" });

    const [row] = await app.db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
    expect(row?.userId).toBe(admin.userId);
    expect(row?.hostname).toBe("h2");
    expect(row?.instanceId).toBe("i2");
  });
});
