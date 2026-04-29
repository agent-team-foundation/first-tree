import { randomBytes } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
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
export async function findOrCreateUserFromGithub(db: Database, profile: GithubProfile): Promise<{ userId: string }> {
  const [existing] = await db
    .select({ userId: authIdentities.userId })
    .from(authIdentities)
    .where(and(eq(authIdentities.provider, "github"), eq(authIdentities.identifier, profile.githubId)))
    .limit(1);

  if (existing) {
    if (profile.email) {
      await db
        .update(authIdentities)
        .set({ email: profile.email, updatedAt: new Date() })
        .where(and(eq(authIdentities.provider, "github"), eq(authIdentities.identifier, profile.githubId)));
    }
    return { userId: existing.userId };
  }

  // Legacy bridge: a pre-OAuth password user whose `users.username` already
  // equals this GitHub login but who has never bound a github identity yet.
  // First time that user clicks "Continue with GitHub", auto-bind the new
  // identity to the existing row so they land on their existing organization
  // instead of getting a freshly minted personal team.
  //
  // Strict matching: case-insensitive username equality AND zero rows in
  // `auth_identities` for `(provider='github')` under that user. The
  // (provider, identifier) UNIQUE on auth_identities makes a duplicate insert
  // race-impossible. Risk: a fresh GitHub login that collides with a legacy
  // username "claims" that account; for SaaS the legacy set is the early
  // dogfooders (real GitHub handles), so collision risk is effectively zero.
  const candidateLogin = profile.login.toLowerCase();
  const [legacyUser] = await db
    .select({ id: users.id })
    .from(users)
    .leftJoin(authIdentities, and(eq(authIdentities.userId, users.id), eq(authIdentities.provider, "github")))
    .where(and(sql`lower(${users.username}) = ${candidateLogin}`, isNull(authIdentities.id)))
    .limit(1);

  if (legacyUser) {
    await db.insert(authIdentities).values({
      id: uuidv7(),
      userId: legacyUser.id,
      provider: "github",
      identifier: profile.githubId,
      email: profile.email,
      verifiedAt: new Date(),
      metadata: { login: profile.login, migratedFrom: "legacy_password" },
    });
    return { userId: legacyUser.id };
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
    await tx.insert(authIdentities).values({
      id: uuidv7(),
      userId,
      provider: "github",
      identifier: profile.githubId,
      email: profile.email,
      verifiedAt: new Date(),
      metadata: { login: profile.login },
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
