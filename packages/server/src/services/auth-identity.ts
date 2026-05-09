import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { authIdentities } from "../db/schema/auth-identities.js";
import { users } from "../db/schema/users.js";
import { uuidv7 } from "../uuid.js";

export type GithubProfile = {
  /** GitHub numeric id — stable for the lifetime of the account. */
  githubId: string;
  /** Login slug (`octocat`). */
  login: string;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
};

/**
 * Find or create the user backing a GitHub OAuth identity. Idempotent —
 * subsequent logins by the same `githubId` reuse the prior `user_id` row.
 *
 * SaaS users have no password. The legacy `users.password_hash` column is
 * NOT NULL (preserved for self-host), so we fill it with a non-functional
 * 32-byte random string. The bcrypt comparison in `authService.login`
 * treats it as a plain string and rejects every password — that's the
 * intended behaviour: SaaS users cannot fall back to password login.
 */
export async function findOrCreateUserFromGithub(
  db: Database,
  profile: GithubProfile,
  opts: { encryptedAccessToken?: string } = {},
): Promise<{ userId: string }> {
  const [existing] = await db
    .select({ userId: authIdentities.userId, metadata: authIdentities.metadata })
    .from(authIdentities)
    .where(and(eq(authIdentities.provider, "github"), eq(authIdentities.identifier, profile.githubId)))
    .limit(1);

  if (existing) {
    const patch: Record<string, unknown> = {};
    if (profile.email) patch.email = profile.email;
    if (opts.encryptedAccessToken) {
      // Refresh the stored token on every sign-in so a re-OAuth (e.g. user
      // expanded scopes) takes effect immediately.
      const merged = { ...(existing.metadata ?? {}), accessToken: opts.encryptedAccessToken, login: profile.login };
      patch.metadata = merged;
    }
    if (Object.keys(patch).length > 0) {
      await db
        .update(authIdentities)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(authIdentities.provider, "github"), eq(authIdentities.identifier, profile.githubId)));
    }
    return { userId: existing.userId };
  }

  const userId = uuidv7();
  // GitHub login is allowed to have characters (uppercase, dots) that the
  // username column technically permits — but ours uses it as the legacy
  // login key, so collisions aren't impossible. Disambiguate with a 4-char
  // suffix on collision; we never re-issue the suffix because the user_id
  // is the actual key.
  const baseUsername = profile.login.toLowerCase();
  const placeholderHash = `oauth:${randomBytes(32).toString("base64url")}`;

  await insertWithUsernameRetry(db, baseUsername, async (tx, username) => {
    await tx.insert(users).values({
      id: userId,
      username,
      passwordHash: placeholderHash,
      displayName: profile.displayName?.trim() || profile.login,
      avatarUrl: profile.avatarUrl ?? null,
    });
    const metadata: Record<string, unknown> = { login: profile.login };
    if (opts.encryptedAccessToken) metadata.accessToken = opts.encryptedAccessToken;
    await tx.insert(authIdentities).values({
      id: uuidv7(),
      userId,
      provider: "github",
      identifier: profile.githubId,
      email: profile.email,
      verifiedAt: new Date(),
      metadata,
    });
  });

  return { userId };
}

/** Postgres `unique_violation` SQLSTATE — emitted when a UNIQUE constraint trips. */
const PG_UNIQUE_VIOLATION = "23505";

/**
 * Pick a candidate username, attempt the caller's INSERT in a transaction,
 * and retry under a fresh disambiguator if the UNIQUE(users.username)
 * constraint trips. Two concurrent OAuth sign-ins for the same GitHub
 * `login` would otherwise let one INSERT win and the other 500 — the
 * race window between the pre-check `SELECT` and the `INSERT` is small but
 * non-zero in production. Retry budget is small; pathological storms fall
 * back to a fully-random suffix.
 */
async function insertWithUsernameRetry(
  db: Database,
  base: string,
  insert: (tx: Database, username: string) => Promise<void>,
): Promise<void> {
  const [hit] = await db.select({ id: users.id }).from(users).where(eq(users.username, base)).limit(1);
  let candidate = hit ? `${base}-${randomBytes(2).toString("hex")}` : base;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await db.transaction(async (tx) => {
        await insert(tx as unknown as Database, candidate);
      });
      return;
    } catch (err) {
      const code = (err as { code?: string })?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
      if (code !== PG_UNIQUE_VIOLATION) throw err;
      candidate = `${base}-${randomBytes(2).toString("hex")}`;
    }
  }

  // After 4 retries something is badly wrong (or extremely unlucky) — fall
  // back to a fully-random suffix so the operator always succeeds.
  candidate = `${base}-${uuidv7().slice(0, 12)}`;
  await db.transaction(async (tx) => {
    await insert(tx as unknown as Database, candidate);
  });
}
