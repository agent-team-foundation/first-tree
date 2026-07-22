import { randomBytes } from "node:crypto";
import {
  type AuthProvider,
  type ExternalAccountProfile,
  githubExternalProfile,
  normalizeExternalProfile,
} from "@first-tree/shared";
import { and, eq } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { authIdentities } from "../db/schema/auth-identities.js";
import { users } from "../db/schema/users.js";
import { uuidv7 } from "../uuid.js";
import { decryptValue } from "./crypto.js";

export type GithubProfile = {
  githubId: string;
  login: string;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
};

export type GithubTokenBundle = {
  encryptedAccessToken?: string;
  accessTokenExpiresAt?: string;
  encryptedRefreshToken?: string;
  refreshTokenExpiresAt?: string;
};

export type AuthProviderAvailability = Readonly<Record<AuthProvider, boolean>>;

export type AuthCredentialSnapshot = {
  provider: string;
  identifier: string;
  credentialType: string | null;
};

export class IdentityConflictError extends Error {
  constructor() {
    super("External identity already belongs to another user");
    this.name = "IdentityConflictError";
  }
}

export class LastIdentityError extends Error {
  constructor() {
    super("The last authentication provider cannot be disconnected");
    this.name = "LastIdentityError";
  }
}

export class IdentityMismatchError extends Error {
  constructor() {
    super("Re-authenticated identity does not match the connected identity");
    this.name = "IdentityMismatchError";
  }
}

export function isUsableLegacyPasswordHash(passwordHash: string): boolean {
  return /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(passwordHash);
}

export function hasUsableAuthentication(
  identities: readonly AuthCredentialSnapshot[],
  passwordHash: string,
  availability: AuthProviderAvailability,
  excludedProvider?: AuthProvider,
): boolean {
  if (isUsableLegacyPasswordHash(passwordHash)) return true;
  return identities.some((identity) => {
    if (identity.provider === excludedProvider) return false;
    if (identity.credentialType === "password" || identity.credentialType === "webauthn") return true;
    if (identity.provider !== "google" && identity.provider !== "github") return false;
    return availability[identity.provider];
  });
}

export async function findOrCreateUserFromExternalAccount(
  db: Database,
  profile: ExternalAccountProfile,
): Promise<{ userId: string; username: string; displayName: string; created: boolean }> {
  const [existing] = await db
    .select({ userId: authIdentities.userId })
    .from(authIdentities)
    .where(and(eq(authIdentities.provider, profile.provider), eq(authIdentities.identifier, profile.subject)))
    .limit(1);

  if (existing) {
    await updateIdentitySnapshot(db, existing.userId, profile);
    const [user] = await db
      .select({ username: users.username, displayName: users.displayName })
      .from(users)
      .where(eq(users.id, existing.userId))
      .limit(1);
    if (!user) throw new Error("External identity references a missing user");
    return { userId: existing.userId, ...user, created: false };
  }

  const userId = uuidv7();
  const normalized = normalizeExternalProfile(profile);
  const placeholderHash = `oauth:${randomBytes(32).toString("base64url")}`;
  let finalUsername = normalized.username;

  try {
    await insertWithUsernameRetry(db, normalized.username, async (tx, username) => {
      finalUsername = username;
      await tx.insert(users).values({
        id: userId,
        username,
        passwordHash: placeholderHash,
        displayName: normalized.displayName,
        avatarUrl: profile.avatarUrl,
      });
      await tx.insert(authIdentities).values(identityValues(userId, profile));
    });
  } catch (error) {
    if (uniqueViolationConstraint(error) !== "uq_auth_identities_provider_identifier") throw error;
    const [winner] = await db
      .select({ userId: authIdentities.userId })
      .from(authIdentities)
      .where(and(eq(authIdentities.provider, profile.provider), eq(authIdentities.identifier, profile.subject)))
      .limit(1);
    if (!winner) throw error;
    const [user] = await db
      .select({ username: users.username, displayName: users.displayName })
      .from(users)
      .where(eq(users.id, winner.userId))
      .limit(1);
    if (!user) throw error;
    return { userId: winner.userId, ...user, created: false };
  }

  return { userId, username: finalUsername, displayName: normalized.displayName, created: true };
}

export async function linkExternalIdentity(
  db: Database,
  userId: string,
  profile: ExternalAccountProfile,
): Promise<"linked" | "already-linked"> {
  try {
    return await db.transaction(async (tx) => {
      const [bySubject] = await tx
        .select({ userId: authIdentities.userId })
        .from(authIdentities)
        .where(and(eq(authIdentities.provider, profile.provider), eq(authIdentities.identifier, profile.subject)))
        .limit(1);
      if (bySubject && bySubject.userId !== userId) throw new IdentityConflictError();
      if (bySubject) {
        await updateIdentitySnapshot(tx as unknown as Database, userId, profile);
        return "already-linked";
      }

      const [byProvider] = await tx
        .select({ identifier: authIdentities.identifier })
        .from(authIdentities)
        .where(and(eq(authIdentities.userId, userId), eq(authIdentities.provider, profile.provider)))
        .limit(1);
      if (byProvider) throw new IdentityConflictError();
      await tx.insert(authIdentities).values(identityValues(userId, profile));
      return "linked";
    });
  } catch (error) {
    const constraint = uniqueViolationConstraint(error);
    if (errorField(error, "code") !== PG_UNIQUE_VIOLATION) throw error;
    if (constraint === "uq_auth_identities_provider_identifier") {
      const [winner] = await db
        .select({ userId: authIdentities.userId })
        .from(authIdentities)
        .where(and(eq(authIdentities.provider, profile.provider), eq(authIdentities.identifier, profile.subject)))
        .limit(1);
      if (!winner) throw error;
      if (winner.userId !== userId) throw new IdentityConflictError();
      await updateIdentitySnapshot(db, userId, profile);
      return "already-linked";
    }
    if (constraint === "uq_auth_identities_user_provider") {
      const [current] = await db
        .select({ identifier: authIdentities.identifier })
        .from(authIdentities)
        .where(and(eq(authIdentities.userId, userId), eq(authIdentities.provider, profile.provider)))
        .limit(1);
      if (!current) throw error;
      if (current.identifier !== profile.subject) throw new IdentityConflictError();
      await updateIdentitySnapshot(db, userId, profile);
      return "already-linked";
    }
    throw error;
  }
}

export async function unlinkExternalIdentity(
  db: Database,
  userId: string,
  provider: AuthProvider,
  reauthenticatedSubject: string,
  availability: AuthProviderAvailability,
  targetIdentityId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [user] = await tx
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, userId))
      .for("no key update");
    if (!user) throw new Error("Cannot disconnect authentication provider for a missing user");
    const identities = await tx
      .select({
        id: authIdentities.id,
        provider: authIdentities.provider,
        identifier: authIdentities.identifier,
        credentialType: authIdentities.credentialType,
      })
      .from(authIdentities)
      .where(eq(authIdentities.userId, userId))
      .for("update");
    const target = identities.find((identity) => identity.provider === provider);
    if (!target || target.id !== targetIdentityId || target.identifier !== reauthenticatedSubject) {
      throw new IdentityMismatchError();
    }
    if (!hasUsableAuthentication(identities, user.passwordHash, availability, provider)) {
      throw new LastIdentityError();
    }
    await tx.delete(authIdentities).where(eq(authIdentities.id, target.id));
  });
}

export async function findOrCreateGithubAccount(
  db: Database,
  profile: GithubProfile,
  opts: GithubTokenBundle = {},
): Promise<{ userId: string; username: string; displayName: string; created: boolean }> {
  const external = githubExternalProfile({
    id: profile.githubId,
    login: profile.login,
    name: profile.displayName,
    email: profile.email,
    avatarUrl: profile.avatarUrl,
    metadata: buildTokenMetadataPatch(profile, opts) ?? {},
  });
  return findOrCreateUserFromExternalAccount(db, external);
}

export async function findOrCreateUserFromGithub(
  db: Database,
  profile: GithubProfile,
  opts: GithubTokenBundle = {},
): Promise<{ userId: string }> {
  const account = await findOrCreateGithubAccount(db, profile, opts);
  return { userId: account.userId };
}

export async function getStoredGithubAccessToken(
  db: Database,
  userId: string,
  encryptionKey: string,
): Promise<string | null> {
  const [identity] = await db
    .select({ metadata: authIdentities.metadata })
    .from(authIdentities)
    .where(and(eq(authIdentities.provider, "github"), eq(authIdentities.userId, userId)))
    .limit(1);
  const meta = identity?.metadata && typeof identity.metadata === "object" ? identity.metadata : null;
  const encrypted = meta && typeof meta.accessToken === "string" && meta.accessToken ? meta.accessToken : null;
  if (!encrypted) return null;
  try {
    return decryptValue(encrypted, encryptionKey);
  } catch {
    return null;
  }
}

function identityValues(userId: string, profile: ExternalAccountProfile) {
  return {
    id: uuidv7(),
    userId,
    provider: profile.provider,
    identifier: profile.subject,
    email: profile.email,
    verifiedAt: new Date(),
    metadata: {
      ...profile.metadata,
      accountName: accountNameFromProfile(profile),
      avatarUrl: profile.avatarUrl,
    },
  };
}

async function updateIdentitySnapshot(db: Database, userId: string, profile: ExternalAccountProfile): Promise<void> {
  const [current] = await db
    .select({ metadata: authIdentities.metadata })
    .from(authIdentities)
    .where(and(eq(authIdentities.userId, userId), eq(authIdentities.provider, profile.provider)))
    .limit(1);
  await db
    .update(authIdentities)
    .set({
      email: profile.email,
      metadata: {
        ...(current?.metadata ?? {}),
        ...profile.metadata,
        accountName: accountNameFromProfile(profile),
        avatarUrl: profile.avatarUrl,
      },
      updatedAt: new Date(),
    })
    .where(and(eq(authIdentities.userId, userId), eq(authIdentities.provider, profile.provider)));
}

function accountNameFromProfile(profile: ExternalAccountProfile): string | null {
  const first = profile.usernameCandidates.find((candidate) => candidate.trim().length > 0);
  return first?.trim() || profile.displayName?.trim() || null;
}

function buildTokenMetadataPatch(profile: GithubProfile, opts: GithubTokenBundle): Record<string, unknown> | null {
  const patch: Record<string, unknown> = { login: profile.login };
  if (opts.encryptedAccessToken) patch.accessToken = opts.encryptedAccessToken;
  if (opts.accessTokenExpiresAt) patch.accessTokenExpiresAt = opts.accessTokenExpiresAt;
  if (opts.encryptedRefreshToken) patch.refreshToken = opts.encryptedRefreshToken;
  if (opts.refreshTokenExpiresAt) patch.refreshTokenExpiresAt = opts.refreshTokenExpiresAt;
  return patch;
}

const PG_UNIQUE_VIOLATION = "23505";

async function insertWithUsernameRetry(
  db: Database,
  base: string,
  insert: (tx: Database, username: string) => Promise<void>,
): Promise<void> {
  const [hit] = await db.select({ id: users.id }).from(users).where(eq(users.username, base)).limit(1);
  let candidate = hit ? `${base}-${randomBytes(2).toString("hex")}` : base;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await db.transaction(async (tx) => insert(tx as unknown as Database, candidate));
      return;
    } catch (error) {
      const code = errorField(error, "code");
      if (code !== PG_UNIQUE_VIOLATION) throw error;
      const constraint = uniqueViolationConstraint(error);
      if (constraint !== "users_username_unique") throw error;
      candidate = `${base}-${randomBytes(2).toString("hex")}`;
    }
  }
  candidate = `${base}-${uuidv7().slice(0, 12)}`;
  await db.transaction(async (tx) => insert(tx as unknown as Database, candidate));
}

function uniqueViolationConstraint(error: unknown): string | undefined {
  return errorField(error, "constraint_name") ?? errorField(error, "constraint");
}

function errorField(error: unknown, field: "code" | "constraint" | "constraint_name"): string | undefined {
  const visited = new Set<object>();
  let current: unknown = error;
  while (current && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    const value = Reflect.get(current, field);
    if (typeof value === "string") return value;
    current = Reflect.get(current, "cause");
  }
  return undefined;
}
