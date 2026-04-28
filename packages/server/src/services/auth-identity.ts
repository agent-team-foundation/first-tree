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

  const userId = uuidv7();
  // GitHub login is allowed to have characters (uppercase, dots) that the
  // username column technically permits — but ours uses it as the legacy
  // login key, so collisions aren't impossible. Disambiguate with a 4-char
  // suffix on collision; we never re-issue the suffix because the user_id
  // is the actual key.
  const baseUsername = profile.login.toLowerCase();
  const username = await pickUniqueUsername(db, baseUsername);
  const placeholderHash = `oauth:${randomBytes(32).toString("base64url")}`;

  await db.transaction(async (tx) => {
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

async function pickUniqueUsername(db: Database, base: string): Promise<string> {
  const [hit] = await db.select({ id: users.id }).from(users).where(eq(users.username, base)).limit(1);
  if (!hit) return base;
  for (let i = 0; i < 8; i += 1) {
    const candidate = `${base}-${randomBytes(2).toString("hex")}`;
    const [exists] = await db.select({ id: users.id }).from(users).where(eq(users.username, candidate)).limit(1);
    if (!exists) return candidate;
  }
  // Pathological collision storm — fall back to a fully-random slug. The
  // user can rename later if they want a vanity username.
  return `${base}-${uuidv7().slice(0, 12)}`;
}
