import crypto from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { decodeJwt } from "jose";
import { describe, expect, it } from "vitest";
import { consumedTokenIds } from "../db/schema/consumed-token-ids.js";
import { users } from "../db/schema/users.js";
import { exchangeConnectToken, generateConnectToken, sweepExpiredConsumedTokenIds } from "../services/auth.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

const EXPIRIES = { accessTokenExpiry: "30m", refreshTokenExpiry: "30d" };

/**
 * Connect-token single-use enforcement is backed by the
 * `consumed_token_ids` ledger (INSERT … ON CONFLICT DO NOTHING), so it
 * holds across server instances and restarts — the property the previous
 * in-process Map could not provide. Exercised at the service level against
 * the real test database; one exchange also runs through the HTTP route to
 * pin the end-to-end wiring. Assertions are keyed to this test's own JTIs —
 * the test database is shared, so the table is never assumed empty.
 */
describe("connect token JTI replay protection", () => {
  const getApp = useTestApp();

  it("rejects a second exchange of the same token (DB-backed, not in-process)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const secret = app.config.secrets.jwtSecret;
    const { token } = await generateConnectToken(admin.userId, secret, { connectTokenExpiry: "10m" });
    const jti = decodeJwt(token).jti;
    if (!jti) throw new Error("connect token must carry a jti");

    const first = await exchangeConnectToken(app.db, token, secret, EXPIRIES);
    expect(first.accessToken).toBeTruthy();

    // The replay decision must come from the database ledger, not process
    // memory: the consumption row exists and a re-exchange is rejected.
    const rows = await app.db
      .select({ jti: consumedTokenIds.jti })
      .from(consumedTokenIds)
      .where(eq(consumedTokenIds.jti, jti));
    expect(rows.length).toBe(1);
    await expect(exchangeConnectToken(app.db, token, secret, EXPIRIES)).rejects.toThrow(
      "Connect token has already been used",
    );
  });

  it("burns the JTI even when the exchange fails after consumption", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const secret = app.config.secrets.jwtSecret;
    const { token } = await generateConnectToken(admin.userId, secret, { connectTokenExpiry: "10m" });

    // Suspend the user so the exchange fails AFTER the ledger insert.
    await app.db.update(users).set({ status: "suspended" }).where(eq(users.id, admin.userId));
    await expect(exchangeConnectToken(app.db, token, secret, EXPIRIES)).rejects.toThrow("User not found or suspended");

    // Reactivate — the token must STILL be rejected: a failed attempt
    // cannot be retried into a replay.
    await app.db.update(users).set({ status: "active" }).where(eq(users.id, admin.userId));
    await expect(exchangeConnectToken(app.db, token, secret, EXPIRIES)).rejects.toThrow(
      "Connect token has already been used",
    );
  });

  it("exchanges once over HTTP and rejects the replay with 401", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const { token } = await generateConnectToken(admin.userId, app.config.secrets.jwtSecret, {
      connectTokenExpiry: "10m",
    });

    const first = await app.inject({ method: "POST", url: "/api/v1/auth/connect-token", payload: { token } });
    expect(first.statusCode).toBe(200);

    const replay = await app.inject({ method: "POST", url: "/api/v1/auth/connect-token", payload: { token } });
    expect(replay.statusCode).toBe(401);
  });

  it("sweeps only rows whose token expiry has passed", async () => {
    const app = getApp();
    const now = Date.now();
    const suffix = crypto.randomUUID().slice(0, 8);
    const expired1 = `expired-1-${suffix}`;
    const expired2 = `expired-2-${suffix}`;
    const live = `live-${suffix}`;
    await app.db.insert(consumedTokenIds).values([
      { jti: expired1, expiresAt: new Date(now - 60_000) },
      { jti: expired2, expiresAt: new Date(now - 1) },
      { jti: live, expiresAt: new Date(now + 600_000) },
    ]);

    // Other tests (and prior runs) may have left their own expired rows in
    // the shared database, so assert on this test's rows, not exact counts.
    const freed = await sweepExpiredConsumedTokenIds(app.db);
    expect(freed).toBeGreaterThanOrEqual(2);

    const remaining = await app.db
      .select({ jti: consumedTokenIds.jti })
      .from(consumedTokenIds)
      .where(inArray(consumedTokenIds.jti, [expired1, expired2, live]));
    expect(remaining.map((r) => r.jti)).toEqual([live]);
  });
});
