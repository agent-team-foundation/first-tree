import { createHash } from "node:crypto";
import { AGENT_SELECTOR_HEADER } from "@first-tree/shared";
import { eq } from "drizzle-orm";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { connectCodes } from "../db/schema/connect-codes.js";
import { members } from "../db/schema/members.js";
import { users } from "../db/schema/users.js";
import { userAuthHook } from "../middleware/user-auth.js";
import {
  generateConnectToken,
  login,
  pickDefaultMembership,
  refreshAccessToken,
  signTokensForUser,
} from "../services/auth.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

const TEST_JWT_SECRET = "test-jwt-secret-key-for-vitest";
const EXPIRIES = { accessTokenExpiry: "30m", refreshTokenExpiry: "30d", connectTokenExpiry: "10m" };

async function signRefreshToken(sub: string): Promise<string> {
  return signJwt({ sub, type: "refresh" });
}

async function signJwt(payload: Record<string, unknown>, secretValue = TEST_JWT_SECRET): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(new TextEncoder().encode(secretValue));
}

describe("Admin Auth", () => {
  const getApp = useTestApp();

  it("pickDefaultMembership breaks createdAt ties by newest uuid", () => {
    const createdAt = new Date("2026-07-08T00:00:00.000Z");
    const picked = pickDefaultMembership([
      { id: "01961234-0000-7000-8000-000000000001", createdAt },
      { id: "01961234-0000-7000-8000-000000000010", createdAt },
    ]);
    expect(picked?.id).toBe("01961234-0000-7000-8000-000000000010");
  });

  describe("userAuthHook", () => {
    async function runHook(
      app: ReturnType<typeof getApp>,
      token: string,
      request: { method?: string; url?: string; headers?: Record<string, string> } = {},
    ): Promise<void> {
      const hook = userAuthHook(app.db, TEST_JWT_SECRET);
      await hook(
        {
          method: request.method ?? "GET",
          url: request.url ?? "/api/v1/me",
          headers: { authorization: `Bearer ${token}`, ...(request.headers ?? {}) },
        } as never,
        {} as never,
      );
    }

    it("classifies invalid signatures, wrong token types, missing users, and suspended users", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app, { username: `hook-admin-${crypto.randomUUID().slice(0, 8)}` });

      await expect(runHook(app, await signJwt({ sub: admin.userId, type: "access" }, "wrong-secret"))).rejects.toThrow(
        /invalid or expired token/i,
      );
      await expect(runHook(app, await signJwt({ sub: admin.userId, type: "refresh" }))).rejects.toThrow(
        /invalid token type/i,
      );
      await expect(
        runHook(app, await signJwt({ sub: `missing-${crypto.randomUUID()}`, type: "access" })),
      ).rejects.toThrow(/user not found|suspended/i);

      const suspended = await createTestAdmin(app, { username: `hook-suspended-${crypto.randomUUID().slice(0, 8)}` });
      await app.db.update(users).set({ status: "suspended" }).where(eq(users.id, suspended.userId));
      await expect(runHook(app, await signJwt({ sub: suspended.userId, type: "access" }))).rejects.toThrow(
        /user not found|suspended/i,
      );
    });

    it("rejects malformed and out-of-scope agent outbox tokens", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app, { username: `hook-outbox-${crypto.randomUUID().slice(0, 8)}` });

      await expect(runHook(app, await signJwt({ sub: admin.userId, type: "agent_outbox" }))).rejects.toThrow(
        /invalid agent outbox token/i,
      );

      const scoped = await signJwt({
        sub: admin.userId,
        type: "agent_outbox",
        agentId: "agent-a",
        chatId: "chat-a",
      });
      await expect(runHook(app, scoped)).rejects.toThrow(/not valid for this request/i);
      await expect(
        runHook(app, scoped, {
          method: "POST",
          url: "/api/v1/agent/chats/%E0%A4%A/messages",
          headers: { [AGENT_SELECTOR_HEADER]: "agent-a" },
        }),
      ).rejects.toThrow(/not valid for this request/i);
    });
  });

  describe("POST /api/v1/auth/login", () => {
    it("returns tokens on valid credentials", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app);
      expect(admin.accessToken).toBeDefined();
      expect(admin.refreshToken).toBeDefined();
    });

    it("rejects invalid password", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app);
      await expect(login(app.db, admin.username, "wrong", TEST_JWT_SECRET, EXPIRIES)).rejects.toThrow(
        /invalid username or password/i,
      );
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { username: "admin", password: "wrong" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("rejects non-existent user", async () => {
      const app = getApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { username: "nobody", password: "whatever" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("rejects suspended users and users without active memberships", async () => {
      const app = getApp();
      const suspended = await createTestAdmin(app, { username: `suspended-${crypto.randomUUID().slice(0, 8)}` });
      await app.db.update(users).set({ status: "suspended" }).where(eq(users.id, suspended.userId));
      await expect(login(app.db, suspended.username, "testpassword123", TEST_JWT_SECRET, EXPIRIES)).rejects.toThrow(
        /invalid username or password/i,
      );

      const removed = await createTestAdmin(app, { username: `removed-${crypto.randomUUID().slice(0, 8)}` });
      await app.db.update(members).set({ status: "removed" }).where(eq(members.userId, removed.userId));
      await expect(login(app.db, removed.username, "testpassword123", TEST_JWT_SECRET, EXPIRIES)).rejects.toThrow(
        /no organization membership/i,
      );
    });

    // Regression: services/auth.ts::pickDefaultMembership picks the most-recently-
    // joined active membership as the /me default. Without `ORDER BY created_at DESC,
    // id DESC` the multi-org user gets a non-deterministic default each request.
    it("picks the most-recently-joined active membership as the default org", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app);

      const create = await app.inject({
        method: "POST",
        url: "/api/v1/me/organizations",
        headers: { authorization: `Bearer ${admin.accessToken}` },
        payload: {
          name: `t-${crypto.randomUUID().slice(0, 8)}`,
          displayName: "Second Org",
        },
      });
      expect(create.statusCode).toBe(201);
      const secondOrgId = create.json<{ organization: { id: string } }>().organization.id;
      expect(secondOrgId).not.toBe(admin.organizationId);

      // /me's defaultOrganizationId should be the most recent join (second org).
      const me = await app.inject({
        method: "GET",
        url: "/api/v1/me",
        headers: { authorization: `Bearer ${admin.accessToken}` },
      });
      expect(me.statusCode).toBe(200);
      expect(me.json<{ defaultOrganizationId: string }>().defaultOrganizationId).toBe(secondOrgId);
    });
  });

  describe("POST /api/v1/auth/refresh", () => {
    it("returns a fresh access+refresh pair (sliding window)", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/refresh",
        payload: { refreshToken: admin.refreshToken },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ accessToken: string; refreshToken: string }>();
      expect(body.accessToken).toBeTruthy();
      expect(body.refreshToken).toBeTruthy();
      // Sliding window: rotated refresh token must differ from the one we sent.
      expect(body.refreshToken).not.toBe(admin.refreshToken);
    });

    it("rejects invalid refresh token", async () => {
      const app = getApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/refresh",
        payload: { refreshToken: "invalid" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("the rotated refresh token can itself be used to refresh again", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app);
      const first = await app.inject({
        method: "POST",
        url: "/api/v1/auth/refresh",
        payload: { refreshToken: admin.refreshToken },
      });
      expect(first.statusCode).toBe(200);
      const next = first.json<{ refreshToken: string }>().refreshToken;
      const second = await app.inject({
        method: "POST",
        url: "/api/v1/auth/refresh",
        payload: { refreshToken: next },
      });
      expect(second.statusCode).toBe(200);
      expect(second.json()).toHaveProperty("accessToken");
    });

    it("rejects wrong token types, missing users, suspended users, and users without active memberships", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app, { username: `refresh-admin-${crypto.randomUUID().slice(0, 8)}` });
      const accessTyped = await signTokensForUser(TEST_JWT_SECRET, admin.userId, EXPIRIES);
      await expect(refreshAccessToken(app.db, accessTyped.accessToken, TEST_JWT_SECRET, EXPIRIES)).rejects.toThrow(
        /invalid token type/i,
      );

      await expect(
        refreshAccessToken(app.db, await signRefreshToken(`missing-${crypto.randomUUID()}`), TEST_JWT_SECRET, EXPIRIES),
      ).rejects.toThrow(/user not found|suspended/i);

      const suspended = await createTestAdmin(app, {
        username: `refresh-suspended-${crypto.randomUUID().slice(0, 8)}`,
      });
      const suspendedRefresh = await signRefreshToken(suspended.userId);
      await app.db.update(users).set({ status: "suspended" }).where(eq(users.id, suspended.userId));
      await expect(refreshAccessToken(app.db, suspendedRefresh, TEST_JWT_SECRET, EXPIRIES)).rejects.toThrow(
        /suspended/i,
      );

      const removed = await createTestAdmin(app, { username: `refresh-removed-${crypto.randomUUID().slice(0, 8)}` });
      const removedRefresh = await signRefreshToken(removed.userId);
      await app.db.update(members).set({ status: "removed" }).where(eq(members.userId, removed.userId));
      await expect(refreshAccessToken(app.db, removedRefresh, TEST_JWT_SECRET, EXPIRIES)).rejects.toThrow(
        /no active membership/i,
      );
    });
  });

  describe("connect token issuer normalization", () => {
    it("normalizes non-URL issuers by trimming trailing slashes", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app, { username: `issuer-admin-${crypto.randomUUID().slice(0, 8)}` });
      const minted = await generateConnectToken(app.db, admin.userId, EXPIRIES, "first-tree-local///");
      const [row] = await app.db
        .select({ issuer: connectCodes.issuer })
        .from(connectCodes)
        .where(eq(connectCodes.codeHash, createHash("sha256").update(minted.token).digest("hex")))
        .limit(1);

      expect(row?.issuer).toBe("first-tree-local");
    });
  });
});
