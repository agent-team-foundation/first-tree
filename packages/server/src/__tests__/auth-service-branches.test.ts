import bcrypt from "bcrypt";
import { describe, expect, it } from "vitest";
import type { Database } from "../db/connection.js";
import { UnauthorizedError } from "../errors.js";

type DbResult = unknown[];

function createDb(results: DbResult[]): Database {
  const next = (): DbResult => results.shift() ?? [];
  const chain = {
    from: () => chain,
    limit: () => next(),
    orderBy: () => chain,
    set: () => chain,
    where: () => chain,
  };
  const db = {
    select: () => chain,
    update: () => chain,
  };
  // Test double implements the Drizzle subset exercised by auth service tests.
  return db as unknown as Database;
}

const secret = "test-secret-that-is-long-enough";
const expiries = {
  accessTokenExpiry: "5m",
  refreshTokenExpiry: "1h",
  connectTokenExpiry: "2m",
};

describe("auth service branch coverage", () => {
  it("covers expiry parsing and default membership tie-breaks", async () => {
    const { expiryToSeconds, pickDefaultMembership } = await import("../services/auth.js");

    expect(expiryToSeconds("30s")).toBe(30);
    expect(expiryToSeconds("10m")).toBe(600);
    expect(expiryToSeconds("2h")).toBe(7200);
    expect(expiryToSeconds("1d")).toBe(86_400);
    expect(expiryToSeconds("1w")).toBe(604_800);
    expect(() => expiryToSeconds("forever")).toThrow("Invalid expiry");
    expect(pickDefaultMembership([])).toBeNull();
    expect(
      pickDefaultMembership([
        { id: "a", createdAt: new Date("2026-05-28T00:00:00.000Z") },
        { id: "b", createdAt: new Date("2026-05-28T00:00:00.000Z") },
      ])?.id,
    ).toBe("b");
  });

  it("covers login rejection branches", async () => {
    const { login } = await import("../services/auth.js");

    await expect(login(createDb([[]]), "ada", "pw", secret, expiries)).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(
      login(createDb([[{ id: "user-1", status: "suspended", passwordHash: "hash" }]]), "ada", "pw", secret, expiries),
    ).rejects.toThrow("Invalid username or password");

    await expect(
      login(createDb([[{ id: "user-1", status: "active", passwordHash: "hash" }]]), "ada", "pw", secret, expiries),
    ).rejects.toThrow("Invalid username or password");
  });

  it("covers login membership and success branches", async () => {
    const { login } = await import("../services/auth.js");
    const passwordHash = await bcrypt.hash("pw", 1);

    await expect(
      login(createDb([[{ id: "user-1", status: "active", passwordHash }], []]), "ada", "pw", secret, expiries),
    ).rejects.toThrow("No organization membership found");

    await expect(
      login(
        createDb([[{ id: "user-1", status: "active", passwordHash }], [{ id: "member-1" }]]),
        "ada",
        "pw",
        secret,
        expiries,
      ),
    ).resolves.toMatchObject({ accessToken: expect.any(String), refreshToken: expect.any(String) });
  });

  it("covers refresh token invalid, wrong-type, user, and membership branches", async () => {
    const { generateConnectToken, refreshAccessToken, signTokensForUser } = await import("../services/auth.js");

    await expect(refreshAccessToken(createDb([]), "not-a-jwt", secret, expiries)).rejects.toThrow(
      "Invalid or expired refresh token",
    );

    const connect = await generateConnectToken("user-1", secret, expiries);
    await expect(refreshAccessToken(createDb([]), connect.token, secret, expiries)).rejects.toThrow(
      "Invalid token type",
    );

    const tokens = await signTokensForUser(secret, "user-1", expiries);
    await expect(refreshAccessToken(createDb([[]]), tokens.refreshToken, secret, expiries)).rejects.toThrow(
      "User not found or suspended",
    );
    await expect(
      refreshAccessToken(createDb([[{ id: "user-1", status: "suspended" }]]), tokens.refreshToken, secret, expiries),
    ).rejects.toThrow("User not found or suspended");
    await expect(
      refreshAccessToken(createDb([[{ id: "user-1", status: "active" }], []]), tokens.refreshToken, secret, expiries),
    ).rejects.toThrow("No active membership");
    await expect(
      refreshAccessToken(
        createDb([[{ id: "user-1", status: "active" }], [{ id: "member-1" }]]),
        tokens.refreshToken,
        secret,
        expiries,
      ),
    ).resolves.toMatchObject({ accessToken: expect.any(String), refreshToken: expect.any(String) });
  });

  it("covers connect token invalid, wrong-type, replay, user, and membership branches", async () => {
    const { exchangeConnectToken, generateConnectToken, signTokensForUser } = await import("../services/auth.js");

    await expect(exchangeConnectToken(createDb([]), "not-a-jwt", secret, expiries)).rejects.toThrow(
      "Invalid or expired connect token",
    );

    const tokens = await signTokensForUser(secret, "user-1", expiries);
    await expect(exchangeConnectToken(createDb([]), tokens.accessToken, secret, expiries)).rejects.toThrow(
      "Invalid token type",
    );

    const missingUser = await generateConnectToken("missing-user", secret, expiries);
    await expect(exchangeConnectToken(createDb([[]]), missingUser.token, secret, expiries)).rejects.toThrow(
      "User not found or suspended",
    );

    const noMembership = await generateConnectToken("user-no-member", secret, expiries);
    await expect(
      exchangeConnectToken(
        createDb([[{ id: "user-no-member", status: "active" }], []]),
        noMembership.token,
        secret,
        expiries,
      ),
    ).rejects.toThrow("No active membership");

    const oneShot = await generateConnectToken("user-1", secret, expiries, "http://127.0.0.1:8000");
    await expect(
      exchangeConnectToken(
        createDb([[{ id: "user-1", status: "active" }], [{ id: "member-1" }]]),
        oneShot.token,
        secret,
        expiries,
      ),
    ).resolves.toMatchObject({ accessToken: expect.any(String), refreshToken: expect.any(String) });
    await expect(exchangeConnectToken(createDb([]), oneShot.token, secret, expiries)).rejects.toThrow(
      "already been used",
    );
  });
});
