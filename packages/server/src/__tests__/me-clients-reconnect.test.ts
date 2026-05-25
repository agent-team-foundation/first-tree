import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { clients } from "../db/schema/clients.js";
import * as clientService from "../services/client.js";
import { createAdminContext, useTestApp } from "./helpers.js";

/**
 * Server-side regression net for the "+ New Connection" modal fix
 * (`packages/web/src/pages/clients/new-connection-dialog.tsx`).
 *
 * The web modal flips Waiting→Connected by polling `GET /me/clients` and
 * matching the predicate
 *
 *   c.status === "connected" && c.userId === me && c.connectedAt >= openedAt
 *
 * The predicate is unit-tested as a pure function (`selectArrivedClient`).
 * What this file pins is the *server contract* the predicate relies on:
 * when the CLI re-registers an already-known `client_id` (i.e. the
 * `ON CONFLICT DO UPDATE` branch of `registerClient`, hit on every
 * "machine that was previously paired and now reconnects"), `connectedAt`
 * is rewritten to the new handshake time AND that timestamp survives the
 * `/me/clients` wire serialization.
 *
 * Without this, an id-set baseline (the previous web implementation) was
 * silently correct only for brand-new machines. Reconnects reused the
 * same `clients.id` row, so the diff was empty and the modal hung in
 * Waiting forever. See PR #505 for full root-cause analysis.
 */

const FUDGE_MS = 1_000;

describe("GET /me/clients — reconnect path rewrites connectedAt", () => {
  const getApp = useTestApp();

  it("re-registering an existing client_id stamps connectedAt to NOW and the wire reflects it", async () => {
    const app = getApp();
    const ctx = await createAdminContext(app);
    const clientId = `cli-rc-${crypto.randomUUID().slice(0, 8)}`;

    // First handshake — INSERT branch of registerClient. Mirrors the very
    // first `first-tree login <token>` on a fresh machine.
    await clientService.registerClient(app.db, {
      clientId,
      userId: ctx.userId,
      organizationId: ctx.organizationId,
      instanceId: "test-instance",
    });

    const first = await app.inject({
      method: "GET",
      url: "/api/v1/me/clients",
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(first.statusCode).toBe(200);
    const firstRow = (first.json() as Array<{ id: string; status: string; connectedAt: string | null }>).find(
      (c) => c.id === clientId,
    );
    if (!firstRow?.connectedAt) throw new Error("first registration did not stamp connectedAt");
    expect(firstRow.status).toBe("connected");
    const connectedAt1 = Date.parse(firstRow.connectedAt);

    // Simulate WS close — status flips to disconnected. `connectedAt` is
    // intentionally NOT touched here (see services/client.ts disconnectClient);
    // it stays at T1 until the next register rewrites it.
    await clientService.disconnectClient(app.db, clientId);

    // Capture the modal-open stamp. Match production logic — the dialog at
    // packages/web/src/pages/clients/new-connection-dialog.tsx applies a 1s
    // fudge to absorb browser↔server clock skew; we apply the same here so
    // the boundary assertion mirrors what the predicate actually evaluates.
    const openedAt = Date.now() - FUDGE_MS;

    // A small sleep ensures `connectedAt2` lands strictly after `connectedAt1`
    // on machines where PG's NOW() can resolve to the same millisecond as the
    // previous insert. Without it `expect(connectedAt2).toBeGreaterThan(...)`
    // would be flaky.
    await new Promise((r) => setTimeout(r, 25));

    // Second handshake — ON CONFLICT DO UPDATE branch. This is the
    // production scenario where the user runs the connect command on a
    // machine whose client.yaml already pins this stable clientId
    // (`packages/shared/src/config/client-config.ts` declares the id as
    // stable per-machine).
    await clientService.registerClient(app.db, {
      clientId,
      userId: ctx.userId,
      organizationId: ctx.organizationId,
      instanceId: "test-instance",
    });

    const second = await app.inject({
      method: "GET",
      url: "/api/v1/me/clients",
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(second.statusCode).toBe(200);
    const secondRow = (second.json() as Array<{ id: string; status: string; connectedAt: string | null }>).find(
      (c) => c.id === clientId,
    );
    if (!secondRow?.connectedAt) throw new Error("reconnect did not stamp connectedAt");
    expect(secondRow.status).toBe("connected");
    const connectedAt2 = Date.parse(secondRow.connectedAt);

    // Contract 1: reconnect rewrites connectedAt. Without this the modal's
    // timestamp-based detector would never fire on re-pairs.
    expect(connectedAt2).toBeGreaterThan(connectedAt1);

    // Contract 2: the new stamp is at or after the modal-open timestamp.
    // This is exactly the comparison `selectArrivedClient` makes — proving
    // the server delivers a value that flips Waiting → Connected for the
    // reconnect case.
    expect(connectedAt2).toBeGreaterThanOrEqual(openedAt);
  });

  it("a long-standing connection's historical connectedAt stays BELOW a later modal-open stamp (no false success)", async () => {
    // Counterpart to the test above: an already-connected machine sitting in
    // the list with a connectedAt from minutes ago must not be picked up as
    // "just arrived" when the user opens the modal. This is the second
    // unchecked manual case from the PR review — pinned at the contract
    // level so it can't regress silently.
    const app = getApp();
    const ctx = await createAdminContext(app);
    const clientId = `cli-old-${crypto.randomUUID().slice(0, 8)}`;

    await clientService.registerClient(app.db, {
      clientId,
      userId: ctx.userId,
      organizationId: ctx.organizationId,
      instanceId: "test-instance",
    });

    // Backdate connectedAt directly via PG to simulate a machine that's been
    // connected for a while. A small `setTimeout` wouldn't clear the
    // modal's 1s clock-skew fudge; patching the row makes the historical
    // intent unambiguous regardless of how fast the test runs.
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1_000);
    await app.db.update(clients).set({ connectedAt: oneHourAgo }).where(eq(clients.id, clientId));

    const openedAt = Date.now() - FUDGE_MS;

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me/clients",
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const row = (res.json() as Array<{ id: string; status: string; connectedAt: string | null }>).find(
      (c) => c.id === clientId,
    );
    if (!row?.connectedAt) throw new Error("historical client lost its connectedAt stamp");
    expect(row.status).toBe("connected");
    const connectedAt = Date.parse(row.connectedAt);

    // The historical stamp is strictly before openedAt; the predicate
    // `connectedAt >= openedAt` returns false → modal stays in Waiting.
    expect(connectedAt).toBeLessThan(openedAt);
  });
});
