import { randomUUID } from "node:crypto";
import bcrypt from "bcrypt";
import { and, desc, eq } from "drizzle-orm";
import { jwtVerify, SignJWT } from "jose";
import type { Database } from "../db/connection.js";
import { members } from "../db/schema/members.js";
import { users } from "../db/schema/users.js";
import { ForbiddenError, UnauthorizedError } from "../errors.js";

const ACCESS_TOKEN_EXPIRY = "30m";
const REFRESH_TOKEN_EXPIRY = "7d";
const CONNECT_TOKEN_EXPIRY = "10m";
/**
 * User-only tokens are short-lived because they're issued to brand-new SaaS
 * sign-ins who haven't picked / created a workspace yet. The frontend
 * exchanges them for a per-org token via `/me/workspaces*` or
 * `/auth/switch-org` quickly — long-lived user tokens would let an attacker
 * who steals one keep enumerating workspace lookups indefinitely.
 */
const USER_TOKEN_EXPIRY = "30m";

/** In-memory set of consumed connect token JTIs. Entries auto-expire after 10 minutes. */
const consumedConnectJtis = new Map<string, number>();
const CONNECT_JTI_TTL_MS = 600_000;

/**
 * `type: "user"` is a "rootless" JWT — it carries only `sub` (userId) and
 * authorises only the `/me/workspaces*` + `/auth/switch-org` routes. SaaS
 * sign-in issues a user token when the new account has zero memberships;
 * after Create / Join / Switch the route returns a regular `type: "access"`
 * token scoped to a specific organization.
 */
type TokenPayload = {
  sub: string;
  memberId?: string;
  organizationId?: string;
  role?: string;
  type: "access" | "refresh" | "connect" | "user";
};

async function signToken(
  secret: Uint8Array,
  payload: Omit<TokenPayload, "type"> & { type: TokenPayload["type"] },
  expiry: string,
): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(expiry)
    .sign(secret);
}

export async function login(db: Database, username: string, password: string, jwtSecretKey: string) {
  const [user] = await db.select().from(users).where(eq(users.username, username)).limit(1);

  if (!user || user.status !== "active") {
    throw new UnauthorizedError("Invalid username or password");
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    throw new UnauthorizedError("Invalid username or password");
  }

  // Get first membership (this version: single org)
  const [member] = await db.select().from(members).where(eq(members.userId, user.id)).limit(1);

  if (!member) {
    throw new UnauthorizedError("No organization membership found");
  }

  const secret = new TextEncoder().encode(jwtSecretKey);
  const tokenBase = { sub: user.id, memberId: member.id, organizationId: member.organizationId, role: member.role };
  const accessToken = await signToken(secret, { ...tokenBase, type: "access" }, ACCESS_TOKEN_EXPIRY);
  const refreshToken = await signToken(secret, { ...tokenBase, type: "refresh" }, REFRESH_TOKEN_EXPIRY);

  // Update last login
  await db.update(users).set({ updatedAt: new Date() }).where(eq(users.id, user.id));

  return { accessToken, refreshToken };
}

export async function refreshAccessToken(db: Database, refreshToken: string, jwtSecretKey: string) {
  const secret = new TextEncoder().encode(jwtSecretKey);

  let payload: TokenPayload;
  try {
    const { payload: p } = await jwtVerify(refreshToken, secret);
    payload = p as unknown as TokenPayload;
  } catch {
    throw new UnauthorizedError("Invalid or expired refresh token");
  }

  if (!payload.sub) {
    throw new UnauthorizedError("Invalid token type");
  }

  // Verify user still exists and is active
  const [user] = await db
    .select({ id: users.id, status: users.status })
    .from(users)
    .where(eq(users.id, payload.sub))
    .limit(1);

  if (!user || user.status !== "active") {
    throw new UnauthorizedError("User not found or suspended");
  }

  // Two refresh shapes:
  //   * `type: "refresh"` + memberId  → re-mint a per-org access token; this
  //     is the established self-host path.
  //   * `type: "user"` (no memberId)  → re-mint a rootless user access token
  //     so the SaaS sign-up wizard survives past the 30-min user-token TTL
  //     without forcing the new user to re-OAuth mid-onboarding.
  if (payload.type === "refresh" && payload.memberId) {
    const [member] = await db.select().from(members).where(eq(members.id, payload.memberId)).limit(1);
    if (!member) {
      throw new UnauthorizedError("Membership not found");
    }
    const tokenBase = {
      sub: user.id,
      memberId: member.id,
      organizationId: member.organizationId,
      role: member.role,
    };
    const accessToken = await signToken(secret, { ...tokenBase, type: "access" }, ACCESS_TOKEN_EXPIRY);
    return { accessToken };
  }

  if (payload.type === "user") {
    const accessToken = await signToken(secret, { sub: user.id, type: "user" }, USER_TOKEN_EXPIRY);
    return { accessToken };
  }

  throw new UnauthorizedError("Invalid token type");
}

/**
 * Generate a short-lived connect token for CLI authentication.
 * The connect token carries the member's identity and can be exchanged
 * for full access+refresh tokens via exchangeConnectToken().
 */
export async function generateConnectToken(
  member: { userId: string; memberId: string; organizationId: string; role: string },
  jwtSecretKey: string,
): Promise<{ token: string; expiresIn: number }> {
  const secret = new TextEncoder().encode(jwtSecretKey);
  const jti = randomUUID();
  const token = await new SignJWT({
    sub: member.userId,
    memberId: member.memberId,
    organizationId: member.organizationId,
    role: member.role,
    type: "connect",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setJti(jti)
    .setExpirationTime(CONNECT_TOKEN_EXPIRY)
    .sign(secret);
  return { token, expiresIn: 600 };
}

/**
 * Exchange a connect token for full access+refresh tokens.
 * Validates the connect token, verifies the user is still active,
 * and issues a fresh token pair.
 */
export async function exchangeConnectToken(
  db: Database,
  connectToken: string,
  jwtSecretKey: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const secret = new TextEncoder().encode(jwtSecretKey);

  let payload: TokenPayload;
  try {
    const { payload: p } = await jwtVerify(connectToken, secret);
    payload = p as unknown as TokenPayload;
  } catch {
    throw new UnauthorizedError("Invalid or expired connect token");
  }

  if (payload.type !== "connect" || !payload.sub || !payload.memberId) {
    throw new UnauthorizedError("Invalid token type — expected connect token");
  }

  // One-time use: reject if jti already consumed
  const jti = (payload as unknown as Record<string, unknown>).jti as string | undefined;
  if (jti) {
    if (consumedConnectJtis.has(jti)) {
      throw new UnauthorizedError("Connect token has already been used");
    }
    consumedConnectJtis.set(jti, Date.now());
    // Prune expired entries
    const cutoff = Date.now() - CONNECT_JTI_TTL_MS;
    for (const [k, ts] of consumedConnectJtis) {
      if (ts < cutoff) consumedConnectJtis.delete(k);
    }
  }

  // Verify user still exists and is active
  const [user] = await db
    .select({ id: users.id, status: users.status })
    .from(users)
    .where(eq(users.id, payload.sub))
    .limit(1);

  if (!user || user.status !== "active") {
    throw new UnauthorizedError("User not found or suspended");
  }

  // Verify membership still exists
  const [member] = await db.select().from(members).where(eq(members.id, payload.memberId)).limit(1);

  if (!member) {
    throw new UnauthorizedError("Membership not found");
  }

  const tokenBase = { sub: user.id, memberId: member.id, organizationId: member.organizationId, role: member.role };
  const accessToken = await signToken(secret, { ...tokenBase, type: "access" }, ACCESS_TOKEN_EXPIRY);
  const refreshToken = await signToken(secret, { ...tokenBase, type: "refresh" }, REFRESH_TOKEN_EXPIRY);

  return { accessToken, refreshToken };
}

/**
 * Mint an access + refresh token pair scoped to a single membership. Shared
 * by SaaS sign-in (GitHub callback), workspace create / join, and the
 * `/auth/switch-org` endpoint.
 */
export async function signTokensForMember(
  member: { userId: string; memberId: string; organizationId: string; role: string },
  jwtSecretKey: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const secret = new TextEncoder().encode(jwtSecretKey);
  const base = {
    sub: member.userId,
    memberId: member.memberId,
    organizationId: member.organizationId,
    role: member.role,
  };
  const accessToken = await signToken(secret, { ...base, type: "access" }, ACCESS_TOKEN_EXPIRY);
  const refreshToken = await signToken(secret, { ...base, type: "refresh" }, REFRESH_TOKEN_EXPIRY);
  return { accessToken, refreshToken };
}

/**
 * Mint a "rootless" user token + companion refresh token. Issued when a
 * SaaS sign-in lands on a user with zero memberships — the frontend
 * exchanges it for a per-org token via `/me/workspaces` create / join.
 *
 * The refresh token is also `type: "user"` so the refresh endpoint can
 * keep the rootless context alive without forcing the user to re-OAuth
 * inside the wizard.
 */
export async function signUserTokens(
  userId: string,
  jwtSecretKey: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const secret = new TextEncoder().encode(jwtSecretKey);
  const base = { sub: userId };
  const accessToken = await signToken(secret, { ...base, type: "user" }, USER_TOKEN_EXPIRY);
  const refreshToken = await signToken(secret, { ...base, type: "user" }, REFRESH_TOKEN_EXPIRY);
  return { accessToken, refreshToken };
}

/**
 * Re-issue tokens scoped to a different workspace the user already belongs
 * to. The caller must be authenticated; we verify membership server-side
 * to refuse cross-tenant escalation even if the client lies about the
 * organizationId.
 *
 * Security trade-off (deferred): switch-org returns a fresh refresh token
 * scoped to the target workspace. A leaked 30-min user token can therefore
 * be parlayed into a 7-day refresh in any workspace the victim belongs to,
 * with no JTI tracking on the original session. The proper fix is refresh-
 * token rotation (per-family JTI table + rotation on every refresh), which
 * is meaningfully larger than this PR's scope. Mitigations in place today:
 *   * user tokens are short-lived (30 min)
 *   * sign-in goes through GitHub OAuth (no password to phish)
 *   * `/auth/switch-org` requires an authenticated caller
 * Tracked for the post-M0 hardening pass.
 */
export async function switchOrganization(
  db: Database,
  userId: string,
  organizationId: string,
  jwtSecretKey: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const [member] = await db
    .select()
    .from(members)
    .where(and(eq(members.userId, userId), eq(members.organizationId, organizationId)))
    .limit(1);
  if (!member) {
    // 403 not 404 — the caller is authenticated; we just refuse to grant
    // access to a workspace they're not a member of.
    throw new ForbiddenError("Not a member of the requested workspace");
  }
  return signTokensForMember(
    { userId, memberId: member.id, organizationId: member.organizationId, role: member.role },
    jwtSecretKey,
  );
}

/**
 * Pick the membership a freshly signed-in user should land in by default
 * when they have multiple. Most-recently-created wins — it's the workspace
 * they last cared about. Returns null when the user has no memberships
 * yet (caller must issue a user-only token instead).
 */
export async function pickDefaultMembership(
  db: Database,
  userId: string,
): Promise<{ memberId: string; organizationId: string; role: string } | null> {
  const [latest] = await db
    .select({ memberId: members.id, organizationId: members.organizationId, role: members.role })
    .from(members)
    .where(eq(members.userId, userId))
    .orderBy(desc(members.createdAt))
    .limit(1);
  return latest ?? null;
}
