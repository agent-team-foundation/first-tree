import bcrypt from "bcrypt";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { authIdentities } from "../db/schema/auth-identities.js";
import { users } from "../db/schema/users.js";
import { signTokensForUser } from "../services/auth.js";
import { uuidv7 } from "../uuid.js";
import { createTestApp, useTestApp } from "./helpers.js";

describe("user authentication provider management", () => {
  const getApp = useTestApp({ googleOAuth: true });

  it("reports configured providers without exposing raw subjects", async () => {
    const app = getApp();
    const userId = uuidv7();
    const identitySubject = "google-subject-secret";
    await app.db.insert(users).values({
      id: userId,
      username: "provider-summary",
      passwordHash: "x",
      displayName: "Provider Summary",
    });
    await app.db.insert(authIdentities).values({
      id: uuidv7(),
      userId,
      provider: "google",
      identifier: identitySubject,
      email: "summary@example.com",
      metadata: { accountName: "summary", avatarUrl: null },
    });
    const tokens = await signTokensForUser(app.config.secrets.jwtSecret, userId, app.config.auth);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/me/auth-providers",
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "google",
          available: true,
          connected: true,
          accountName: "summary",
          canUnlink: false,
          unlinkBlockedReason: "last-provider",
        }),
        expect.objectContaining({ provider: "github", available: true, connected: false }),
      ]),
    );
    expect(JSON.stringify(body)).not.toContain(identitySubject);
  });

  it("prevents removing the only currently configured sign-in path", async () => {
    const app = getApp();
    const userId = uuidv7();
    await app.db.insert(users).values({
      id: userId,
      username: "provider-config-change",
      passwordHash: "x",
      displayName: "Provider Config Change",
    });
    await app.db.insert(authIdentities).values([
      {
        id: uuidv7(),
        userId,
        provider: "google",
        identifier: "google-config-change",
        metadata: {},
      },
      {
        id: uuidv7(),
        userId,
        provider: "github",
        identifier: "github-config-change",
        metadata: {},
      },
    ]);
    if (app.config.oauth) Reflect.deleteProperty(app.config.oauth, "google");
    const tokens = await signTokensForUser(app.config.secrets.jwtSecret, userId, app.config.auth);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/me/auth-providers/github/unlink/start",
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "last-provider" });
    const [githubIdentity] = await app.db
      .select({ id: authIdentities.id })
      .from(authIdentities)
      .where(eq(authIdentities.identifier, "github-config-change"));
    expect(githubIdentity).toBeTruthy();
  });
});

describe("user authentication provider availability", () => {
  it("returns provider-not-configured before issuing an OAuth state cookie", async () => {
    const app = await createTestApp({ googleOAuth: false, githubOAuth: true });
    try {
      const userId = uuidv7();
      await app.db.insert(users).values({
        id: userId,
        username: "unconfigured-provider",
        passwordHash: await bcrypt.hash("legacy", 1),
        displayName: "Unconfigured Provider",
      });
      const tokens = await signTokensForUser(app.config.secrets.jwtSecret, userId, app.config.auth);
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/me/auth-providers/google/link/start",
        headers: { authorization: `Bearer ${tokens.accessToken}` },
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: "provider-not-configured" });
      expect(response.headers["set-cookie"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
