import { and, eq } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { authIdentities } from "../db/schema/auth-identities.js";
import { decryptValue, encryptValue } from "./crypto.js";
import { GithubAppApiError, refreshAppUserToken } from "./github-app.js";

const REFRESH_BUFFER_MS = 60_000;

export type GithubUserTokenRefreshConfig = {
  clientId: string;
  clientSecret: string;
};

export type GithubUserToken = {
  accessToken: string;
  login: string;
  githubId: string;
};

export class GithubUserTokenError extends Error {
  constructor(
    public readonly statusCode: 403 | 503,
    message: string,
    public readonly code?: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "GithubUserTokenError";
  }
}

export async function getFreshGithubUserToken(
  db: Database,
  userId: string,
  encryptionKey: string,
  refreshConfig: GithubUserTokenRefreshConfig | undefined,
): Promise<GithubUserToken> {
  const [identity] = await db
    .select({ identifier: authIdentities.identifier, metadata: authIdentities.metadata })
    .from(authIdentities)
    .where(and(eq(authIdentities.userId, userId), eq(authIdentities.provider, "github")))
    .limit(1);

  const metadata = isRecord(identity?.metadata) ? identity.metadata : null;
  const login = metadata ? readString(metadata, "login") : null;
  const encrypted = metadata ? readString(metadata, "accessToken") : null;
  if (!identity || !metadata || !login || !encrypted) {
    throw new GithubUserTokenError(503, "GitHub credentials unavailable. Please reconnect your GitHub account.");
  }

  let accessToken: string;
  try {
    accessToken = decryptValue(encrypted, encryptionKey);
  } catch (err) {
    throw new GithubUserTokenError(
      503,
      "GitHub access token could not be decoded. Please reconnect your GitHub account.",
      undefined,
      err,
    );
  }

  const expiresAtRaw = readString(metadata, "accessTokenExpiresAt");
  const encryptedRefresh = readString(metadata, "refreshToken");
  if (expiresAtRaw && encryptedRefresh && refreshConfig) {
    const expiresAt = Date.parse(expiresAtRaw);
    if (!Number.isNaN(expiresAt) && expiresAt - REFRESH_BUFFER_MS <= Date.now()) {
      try {
        const refreshPlain = decryptValue(encryptedRefresh, encryptionKey);
        const refreshed = await refreshAppUserToken(refreshConfig.clientId, refreshConfig.clientSecret, refreshPlain);
        const nextMetadata: Record<string, unknown> = {
          ...metadata,
          accessToken: encryptValue(refreshed.accessToken, encryptionKey),
          accessTokenExpiresAt: refreshed.accessTokenExpiresAt,
          refreshToken: encryptValue(refreshed.refreshToken, encryptionKey),
          refreshTokenExpiresAt: refreshed.refreshTokenExpiresAt,
        };
        await db
          .update(authIdentities)
          .set({ metadata: nextMetadata, updatedAt: new Date() })
          .where(and(eq(authIdentities.userId, userId), eq(authIdentities.provider, "github")));
        accessToken = refreshed.accessToken;
      } catch (err) {
        const status = err instanceof GithubAppApiError ? err.status : 503;
        if (status === 401) {
          throw new GithubUserTokenError(
            403,
            "Your GitHub session has expired. Please sign in again.",
            "refresh_failed",
            err,
          );
        }
        throw new GithubUserTokenError(
          503,
          "Couldn't refresh GitHub credentials. Try again, or reconnect your GitHub account.",
          undefined,
          err,
        );
      }
    }
  }

  return { accessToken, login, githubId: identity.identifier };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}
