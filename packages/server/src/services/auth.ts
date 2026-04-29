import { randomUUID } from "node:crypto";
import bcrypt from "bcrypt";
import { and, eq } from "drizzle-orm";
import { jwtVerify, SignJWT } from "jose";
import type { Database } from "../db/connection.js";
import { members } from "../db/schema/members.js";
import { users } from "../db/schema/users.js";
import { UnauthorizedError } from "../errors.js";

const ACCESS_TOKEN_EXPIRY = "30m";
const REFRESH_TOKEN_EXPIRY = "7d";
const CONNECT_TOKEN_EXPIRY = "10m";

/** In-memory set of consumed connect token JTIs. Entries auto-expire after 10 minutes. */
const consumedConnectJtis = new Map<string, number>();
const CONNECT_JTI_TTL_MS = 600_000;

type TokenPayload = {
  sub: string;
  memberId: string;
  organizationId: string;
  role: string;
  type: "access" | "refresh" | "connect";
  iss?: string;
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

/**
 * Sign an `(access, refresh)` pair for the given member. Used by both the
 * legacy username/password login path and the SaaS GitHub OAuth callback,
 * so the issuance shape stays in one place.
 */
export async function signTokensForMember(
  jwtSecretKey: string,
  member: { userId: string; memberId: string; organizationId: string; role: string },
): Promise<{ accessToken: string; refreshToken: string }> {
  const secret = new TextEncoder().encode(jwtSecretKey);
  const tokenBase = {
    sub: member.userId,
    memberId: member.memberId,
    organizationId: member.organizationId,
    role: member.role,
  };
  const accessToken = await signToken(secret, { ...tokenBase, type: "access" }, ACCESS_TOKEN_EXPIRY);
  const refreshToken = await signToken(secret, { ...tokenBase, type: "refresh" }, REFRESH_TOKEN_EXPIRY);
  return { accessToken, refreshToken };
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

  // Password login: pick the most recently joined ACTIVE membership. Soft-
  // deleted ("left") rows are ignored so a member who left their last team
  // can't password-login back in without re-joining.
  const [member] = await db
    .select()
    .from(members)
    .where(and(eq(members.userId, user.id), eq(members.status, "active")))
    .limit(1);

  if (!member) {
    throw new UnauthorizedError("No organization membership found");
  }

  const tokens = await signTokensForMember(jwtSecretKey, {
    userId: user.id,
    memberId: member.id,
    organizationId: member.organizationId,
    role: member.role,
  });

  // Update last login
  await db.update(users).set({ updatedAt: new Date() }).where(eq(users.id, user.id));

  return tokens;
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

  if (payload.type !== "refresh" || !payload.sub) {
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

  // Verify membership still exists and hasn't been left.
  const [member] = await db
    .select()
    .from(members)
    .where(and(eq(members.id, payload.memberId), eq(members.status, "active")))
    .limit(1);

  if (!member) {
    throw new UnauthorizedError("Membership not found");
  }

  const tokenBase = { sub: user.id, memberId: member.id, organizationId: member.organizationId, role: member.role };
  const accessToken = await signToken(secret, { ...tokenBase, type: "access" }, ACCESS_TOKEN_EXPIRY);
  return { accessToken };
}

/**
 * Generate a short-lived connect token for CLI authentication.
 * The connect token carries the member's identity and can be exchanged
 * for full access+refresh tokens via exchangeConnectToken().
 *
 * `iss` (when supplied) is stamped into the JWT so the CLI can derive
 * the hub URL with no additional argument. Production servers must
 * always pass it; dev callers may omit and the CLI will require an
 * explicit `--server-url` (legacy form).
 */
export async function generateConnectToken(
  member: { userId: string; memberId: string; organizationId: string; role: string },
  jwtSecretKey: string,
  iss?: string,
): Promise<{ token: string; expiresIn: number }> {
  const secret = new TextEncoder().encode(jwtSecretKey);
  const jti = randomUUID();
  const builder = new SignJWT({
    sub: member.userId,
    memberId: member.memberId,
    organizationId: member.organizationId,
    role: member.role,
    type: "connect",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setJti(jti)
    .setExpirationTime(CONNECT_TOKEN_EXPIRY);
  if (iss) builder.setIssuer(iss);
  const token = await builder.sign(secret);
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

  // Verify membership still exists and hasn't been left.
  const [member] = await db
    .select()
    .from(members)
    .where(and(eq(members.id, payload.memberId), eq(members.status, "active")))
    .limit(1);

  if (!member) {
    throw new UnauthorizedError("Membership not found");
  }

  return signTokensForMember(jwtSecretKey, {
    userId: user.id,
    memberId: member.id,
    organizationId: member.organizationId,
    role: member.role,
  });
}
