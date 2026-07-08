import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { authIdentities } from "../db/schema/auth-identities.js";
import { users } from "../db/schema/users.js";
import { findOrCreateUserFromGithub, getStoredGithubAccessToken } from "../services/auth-identity.js";
import { encryptValue } from "../services/crypto.js";
import { uuidv7 } from "../uuid.js";
import { useTestApp } from "./helpers.js";

const ENCRYPTION_KEY = "0".repeat(64);

describe("auth identity extra coverage", () => {
  const getApp = useTestApp();

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
    expect(user?.displayName).toBe("Octocat");
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
});
