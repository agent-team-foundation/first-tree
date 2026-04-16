import bcrypt from "bcrypt";
import { eq } from "drizzle-orm";
import { jwtVerify, SignJWT } from "jose";
import type { Database } from "../db/connection.js";
import { members } from "../db/schema/members.js";
import { users } from "../db/schema/users.js";
import { UnauthorizedError } from "../errors.js";

const ACCESS_TOKEN_EXPIRY = "30m";
const REFRESH_TOKEN_EXPIRY = "7d";
const CONNECT_TOKEN_EXPIRY = "10m";

type TokenPayload = {
  sub: string;
  memberId: string;
  organizationId: string;
  role: string;
  type: "access" | "refresh" | "connect";
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

  // Verify membership still exists
  const [member] = await db.select().from(members).where(eq(members.id, payload.memberId)).limit(1);

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
 */
export async function generateConnectToken(
  member: { userId: string; memberId: string; organizationId: string; role: string },
  jwtSecretKey: string,
): Promise<{ token: string; expiresIn: number }> {
  const secret = new TextEncoder().encode(jwtSecretKey);
  const token = await signToken(
    secret,
    {
      sub: member.userId,
      memberId: member.memberId,
      organizationId: member.organizationId,
      role: member.role,
      type: "connect",
    },
    CONNECT_TOKEN_EXPIRY,
  );
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
