import { githubExternalProfile } from "@first-tree/shared";
import bcrypt from "bcrypt";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { connectDatabase } from "../db/connection.js";
import { authIdentities } from "../db/schema/auth-identities.js";
import { users } from "../db/schema/users.js";
import { requireAgent } from "../middleware/require-identity.js";
import { requireUser } from "../scope/require-user.js";
import {
  findOrCreateUserFromExternalAccount,
  findOrCreateUserFromGithub,
  getStoredGithubAccessToken,
  hasUsableAuthentication,
  IdentityConflictError,
  isUsableLegacyPasswordHash,
  LastIdentityError,
  linkExternalIdentity,
  unlinkExternalIdentity,
} from "../services/auth-identity.js";
import { encryptValue } from "../services/crypto.js";
import { uuidv7 } from "../uuid.js";
import { useTestApp } from "./helpers.js";

const ENCRYPTION_KEY = "0".repeat(64);

describe("auth identity extra coverage", () => {
  const getApp = useTestApp();

  it("throws clean authentication errors when required identities are missing", () => {
    expect(() => requireAgent({} as never)).toThrow("Agent authentication required");
    expect(() => requireUser({} as never)).toThrow("User authentication required");
  });

  it("creates GitHub identities with username retry and refreshes stored token metadata", async () => {
    const app = getApp();
    await app.db.insert(users).values({
      id: uuidv7(),
      username: "octocat",
      passwordHash: "x",
      displayName: "Existing Octocat",
    });

    const created = await findOrCreateUserFromGithub(app.db, {
      githubId: "gh-100",
      login: "Octocat",
      email: null,
      displayName: "  ",
      avatarUrl: "https://avatars.example/octo.png",
    });

    const [user] = await app.db.select().from(users).where(eq(users.id, created.userId)).limit(1);
    expect(user?.username).toMatch(/^octocat-[0-9a-f]{4}$/);
    expect(user?.displayName).toBe("octocat");
    expect(user?.avatarUrl).toBe("https://avatars.example/octo.png");
    await expect(getStoredGithubAccessToken(app.db, created.userId, ENCRYPTION_KEY)).resolves.toBeNull();

    const encryptedAccessToken = encryptValue("gho_access", ENCRYPTION_KEY);
    const encryptedRefreshToken = encryptValue("ghr_refresh", ENCRYPTION_KEY);
    const existing = await findOrCreateUserFromGithub(
      app.db,
      {
        githubId: "gh-100",
        login: "renamed-octocat",
        email: "octo@example.com",
        displayName: "Renamed Octo",
        avatarUrl: null,
      },
      {
        encryptedAccessToken,
        accessTokenExpiresAt: "2026-07-08T00:00:00.000Z",
        encryptedRefreshToken,
        refreshTokenExpiresAt: "2026-08-08T00:00:00.000Z",
      },
    );

    expect(existing.userId).toBe(created.userId);
    const [identity] = await app.db
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.userId, created.userId))
      .limit(1);
    expect(identity).toMatchObject({
      provider: "github",
      identifier: "gh-100",
      email: "octo@example.com",
    });
    expect(identity?.metadata).toMatchObject({
      login: "renamed-octocat",
      accessToken: encryptedAccessToken,
      accessTokenExpiresAt: "2026-07-08T00:00:00.000Z",
      refreshToken: encryptedRefreshToken,
      refreshTokenExpiresAt: "2026-08-08T00:00:00.000Z",
    });
    await expect(getStoredGithubAccessToken(app.db, created.userId, ENCRYPTION_KEY)).resolves.toBe("gho_access");

    await app.db
      .update(authIdentities)
      .set({ metadata: { accessToken: "enc:v1:not-base64" } })
      .where(eq(authIdentities.userId, created.userId));
    await expect(getStoredGithubAccessToken(app.db, created.userId, ENCRYPTION_KEY)).resolves.toBeNull();
    await expect(getStoredGithubAccessToken(app.db, "missing-user", ENCRYPTION_KEY)).resolves.toBeNull();
  });

  it("falls back to a uuid-based username suffix after repeated unique violations", async () => {
    let transactionAttempts = 0;
    const insertedUsernames: string[] = [];
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [],
          }),
        }),
      }),
      transaction: async (callback: (tx: unknown) => Promise<void>) => {
        transactionAttempts += 1;
        if (transactionAttempts <= 4) {
          const err = new Error("duplicate username") as Error & { code: string; constraint_name: string };
          err.code = "23505";
          err.constraint_name = "users_username_unique";
          throw err;
        }
        await callback({
          insert: () => ({
            values: async (value: Record<string, unknown>) => {
              if (typeof value.username === "string") insertedUsernames.push(value.username);
            },
          }),
        });
      },
    };

    await expect(
      findOrCreateUserFromGithub(fakeDb as never, {
        githubId: "gh-retry",
        login: "retry",
        email: null,
        displayName: null,
        avatarUrl: null,
      }),
    ).resolves.toEqual({ userId: expect.any(String) });

    expect(transactionAttempts).toBe(5);
    expect(insertedUsernames).toHaveLength(1);
    expect(insertedUsernames[0]).toMatch(/^retry-[0-9a-f-]{12}$/);
  });

  it("converges concurrent sign-ins for one external subject onto one user", async () => {
    const app = getApp();
    const databaseUrl = process.env.DATABASE_URL ?? "";
    if (!databaseUrl) throw new Error("DATABASE_URL is required for the concurrency test");
    const firstDb = connectDatabase(databaseUrl);
    const secondDb = connectDatabase(databaseUrl);
    try {
      const profileA = githubExternalProfile({
        id: "gh-concurrent-sign-in",
        login: "race-a",
        name: "Race A",
        email: null,
      });
      const profileB = githubExternalProfile({
        id: "gh-concurrent-sign-in",
        login: "race-b",
        name: "Race B",
        email: null,
      });
      const results = await Promise.all([
        findOrCreateUserFromExternalAccount(firstDb, profileA),
        findOrCreateUserFromExternalAccount(secondDb, profileB),
      ]);

      expect(results[0]?.userId).toBe(results[1]?.userId);
      const usersForIdentity = await app.db
        .select({ userId: authIdentities.userId })
        .from(authIdentities)
        .where(eq(authIdentities.identifier, "gh-concurrent-sign-in"));
      expect(usersForIdentity).toEqual([{ userId: results[0]?.userId }]);
    } finally {
      await firstDb.end();
      await secondDb.end();
    }
  });

  it("maps concurrent identity-link races to idempotence or conflict", async () => {
    const app = getApp();
    const databaseUrl = process.env.DATABASE_URL ?? "";
    if (!databaseUrl) throw new Error("DATABASE_URL is required for the concurrency test");
    const firstDb = connectDatabase(databaseUrl);
    const secondDb = connectDatabase(databaseUrl);
    const firstUserId = uuidv7();
    const secondUserId = uuidv7();
    const providerRaceUserId = uuidv7();
    try {
      await app.db.insert(users).values([
        { id: firstUserId, username: "link-race-a", passwordHash: "x", displayName: "Link Race A" },
        { id: secondUserId, username: "link-race-b", passwordHash: "x", displayName: "Link Race B" },
        { id: providerRaceUserId, username: "link-race-c", passwordHash: "x", displayName: "Link Race C" },
      ]);
      const sharedProfile = githubExternalProfile({
        id: "gh-concurrent-link",
        login: "concurrent-link",
        name: "Concurrent Link",
        email: null,
      });
      const subjectRace = await Promise.allSettled([
        linkExternalIdentity(firstDb, firstUserId, sharedProfile),
        linkExternalIdentity(secondDb, secondUserId, sharedProfile),
      ]);
      expect(subjectRace.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(subjectRace.filter((result) => result.status === "rejected")[0]?.reason).toBeInstanceOf(
        IdentityConflictError,
      );

      const providerRace = await Promise.allSettled([
        linkExternalIdentity(
          firstDb,
          providerRaceUserId,
          githubExternalProfile({ id: "gh-provider-a", login: "provider-a" }),
        ),
        linkExternalIdentity(
          secondDb,
          providerRaceUserId,
          githubExternalProfile({ id: "gh-provider-b", login: "provider-b" }),
        ),
      ]);
      expect(providerRace.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(providerRace.filter((result) => result.status === "rejected")[0]?.reason).toBeInstanceOf(
        IdentityConflictError,
      );
    } finally {
      await firstDb.end();
      await secondDb.end();
    }
  });

  it("protects the last usable credential when provider configuration changes", async () => {
    const app = getApp();
    const oauthOnlyUserId = uuidv7();
    const legacyUserId = uuidv7();
    await app.db.insert(users).values([
      { id: oauthOnlyUserId, username: "oauth-only", passwordHash: "x", displayName: "OAuth Only" },
      {
        id: legacyUserId,
        username: "legacy-password",
        passwordHash: await bcrypt.hash("legacy", 1),
        displayName: "Legacy",
      },
    ]);
    await app.db.insert(authIdentities).values([
      {
        id: uuidv7(),
        userId: oauthOnlyUserId,
        provider: "google",
        identifier: "google-only",
        metadata: {},
      },
      {
        id: uuidv7(),
        userId: oauthOnlyUserId,
        provider: "github",
        identifier: "github-disabled",
        metadata: {},
      },
      {
        id: uuidv7(),
        userId: legacyUserId,
        provider: "google",
        identifier: "google-legacy",
        metadata: {},
      },
    ]);

    expect(isUsableLegacyPasswordHash("x")).toBe(false);
    expect(isUsableLegacyPasswordHash("not-a-bcrypt-hash")).toBe(false);
    expect(
      hasUsableAuthentication(
        [{ provider: "github", identifier: "github-disabled", credentialType: null }],
        "x",
        { google: true, github: false },
        "google",
      ),
    ).toBe(false);

    await expect(
      unlinkExternalIdentity(app.db, oauthOnlyUserId, "google", "google-only", { google: true, github: false }),
    ).rejects.toBeInstanceOf(LastIdentityError);
    await expect(
      unlinkExternalIdentity(app.db, legacyUserId, "google", "google-legacy", { google: true, github: false }),
    ).resolves.toBeUndefined();
  });
});
