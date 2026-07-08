import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptValue } from "../services/crypto.js";

class MockGithubAppApiError extends Error {
  constructor(
    public readonly status: number,
    message = "GitHub App API failed",
  ) {
    super(message);
    this.name = "GithubAppApiError";
  }
}

const refreshMock = vi.fn();

function mockGithubApp(): void {
  vi.doMock("../services/github-app.js", () => ({
    GithubAppApiError: MockGithubAppApiError,
    refreshAppUserToken: refreshMock,
  }));
}

function makeDb(identity: unknown): { db: unknown; updated: { metadata?: unknown } } {
  const updated: { metadata?: unknown } = {};
  const selectChain = {
    from: vi.fn(() => selectChain),
    limit: vi.fn(async () => (identity ? [identity] : [])),
    where: vi.fn(() => selectChain),
  };
  const updateChain = {
    set: vi.fn((value: { metadata?: unknown }) => {
      updated.metadata = value.metadata;
      return updateChain;
    }),
    where: vi.fn(async () => undefined),
  };
  return {
    db: {
      select: vi.fn(() => selectChain),
      update: vi.fn(() => updateChain),
    },
    updated,
  };
}

const key = "a".repeat(64);

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mockGithubApp();
});

afterEach(() => {
  vi.doUnmock("../services/github-app.js");
  vi.resetModules();
});

describe("getFreshGithubUserToken", () => {
  it("returns a decrypted stored token when it is still fresh", async () => {
    const { getFreshGithubUserToken } = await import("../services/github-user-token.js");
    const { db } = makeDb({
      identifier: "123",
      metadata: {
        accessToken: encryptValue("access_1", key),
        accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        login: "octo",
        refreshToken: encryptValue("refresh_1", key),
      },
    });

    await expect(
      getFreshGithubUserToken(db as never, "user_1", key, { clientId: "id", clientSecret: "secret" }),
    ).resolves.toEqual({
      accessToken: "access_1",
      githubId: "123",
      login: "octo",
    });
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("refreshes expiring App user tokens and stores encrypted replacements", async () => {
    const { getFreshGithubUserToken } = await import("../services/github-user-token.js");
    refreshMock.mockResolvedValue({
      accessToken: "access_2",
      accessTokenExpiresAt: "2026-07-08T12:00:00.000Z",
      refreshToken: "refresh_2",
      refreshTokenExpiresAt: "2026-08-08T12:00:00.000Z",
    });
    const { db, updated } = makeDb({
      identifier: "123",
      metadata: {
        accessToken: encryptValue("access_1", key),
        accessTokenExpiresAt: new Date(Date.now() - 1_000).toISOString(),
        login: "octo",
        refreshToken: encryptValue("refresh_1", key),
      },
    });

    await expect(
      getFreshGithubUserToken(db as never, "user_1", key, { clientId: "id", clientSecret: "secret" }),
    ).resolves.toEqual({
      accessToken: "access_2",
      githubId: "123",
      login: "octo",
    });
    expect(refreshMock).toHaveBeenCalledWith("id", "secret", "refresh_1");
    expect(updated.metadata).toMatchObject({
      accessTokenExpiresAt: "2026-07-08T12:00:00.000Z",
      refreshTokenExpiresAt: "2026-08-08T12:00:00.000Z",
    });
  });

  it("fails closed for missing or undecodable GitHub credentials", async () => {
    const { getFreshGithubUserToken } = await import("../services/github-user-token.js");

    await expect(
      getFreshGithubUserToken(makeDb(undefined).db as never, "user_1", key, undefined),
    ).rejects.toMatchObject({
      statusCode: 503,
    });
    await expect(
      getFreshGithubUserToken(
        makeDb({ identifier: "123", metadata: { accessToken: "enc:v1:not-valid", login: "octo" } }).db as never,
        "user_1",
        key,
        undefined,
      ),
    ).rejects.toMatchObject({ statusCode: 503 });
  });

  it("maps refresh failures to reconnectable user-token errors", async () => {
    const { getFreshGithubUserToken } = await import("../services/github-user-token.js");
    const identity = {
      identifier: "123",
      metadata: {
        accessToken: encryptValue("access_1", key),
        accessTokenExpiresAt: new Date(Date.now() - 1_000).toISOString(),
        login: "octo",
        refreshToken: encryptValue("refresh_1", key),
      },
    };

    refreshMock.mockRejectedValueOnce(new MockGithubAppApiError(401));
    await expect(
      getFreshGithubUserToken(makeDb(identity).db as never, "user_1", key, { clientId: "id", clientSecret: "secret" }),
    ).rejects.toMatchObject({ code: "refresh_failed", statusCode: 403 });

    refreshMock.mockRejectedValueOnce(new MockGithubAppApiError(500));
    await expect(
      getFreshGithubUserToken(makeDb(identity).db as never, "user_1", key, { clientId: "id", clientSecret: "secret" }),
    ).rejects.toMatchObject({ statusCode: 503 });
  });
});
