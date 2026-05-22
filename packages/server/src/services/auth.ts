import { randomUUID } from "node:crypto";
import bcrypt from "bcrypt";
import { and, desc, eq } from "drizzle-orm";
import { jwtVerify, SignJWT } from "jose";
import type { Database } from "../db/connection.js";
import { members } from "../db/schema/members.js";
import { users } from "../db/schema/users.js";
import { UnauthorizedError } from "../errors.js";
import { classifyJoseError, decodeJwtForTrace, untrustedAttrs } from "../observability/jwt-trace.js";

/**
 * Token lifetime configuration. Driven by `FIRST_TREE_AUTH_*_EXPIRY`
 * env vars. Refresh tokens slide: every successful refresh issues a fresh
 * pair, so an active client never hits the absolute expiry — the configured
 * `refreshTokenExpiry` is the safety net for clients that go offline.
 */
export type AuthTokenExpiries = {
  accessTokenExpiry: string;
  refreshTokenExpiry: string;
  connectTokenExpiry: string;
};

/** In-memory set of consumed connect token JTIs. Entries auto-expire after 10 minutes. */
const consumedConnectJtis = new Map<string, number>();
const CONNECT_JTI_TTL_MS = 600_000;

/**
 * JWT payload shape. Carries ONLY the user identity — no org / member /
 * role. Anything beyond `userId` is resolved per-request via the
 * `scope/require-*` helpers, which forces every authz decision through a
 * real-time DB probe (kills the JWT-ambient-scope bug class).
 */
type TokenPayload = {
  sub: string;
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
    .setJti(randomUUID())
    .setExpirationTime(expiry)
    .sign(secret);
}

export function expiryToSeconds(expiry: string): number {
  const m = /^(\d+)\s*(s|m|h|d|w)$/.exec(expiry.trim());
  if (!m) {
    throw new Error(`Invalid expiry "${expiry}" — expected forms like "30s", "10m", "2h", "30d", "1w".`);
  }
  const n = Number(m[1]);
  const u = m[2] as "s" | "m" | "h" | "d" | "w";
  const mult = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 } as const;
  return n * mult[u];
}

/**
 * Sign an `(access, refresh)` pair carrying only `sub = userId`.
 */
export async function signTokensForUser(
  jwtSecretKey: string,
  userId: string,
  expiries: Pick<AuthTokenExpiries, "accessTokenExpiry" | "refreshTokenExpiry">,
): Promise<{ accessToken: string; refreshToken: string }> {
  const secret = new TextEncoder().encode(jwtSecretKey);
  const accessToken = await signToken(secret, { sub: userId, type: "access" }, expiries.accessTokenExpiry);
  const refreshToken = await signToken(secret, { sub: userId, type: "refresh" }, expiries.refreshTokenExpiry);
  return { accessToken, refreshToken };
}

/**
 * Pick the user's "default" membership for the web client to land on
 * after login. Most-recently-active membership wins; tie-break by the
 * uuidv7 lexicographic order of `members.id` (matches insert order).
 *
 * Used only by `GET /me` to populate `defaultOrganizationId` — the JWT
 * itself does NOT carry org info anymore.
 */
export function pickDefaultMembership<T extends { id: string; createdAt: Date }>(rows: T[]): T | null {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => {
    const t = b.createdAt.getTime() - a.createdAt.getTime();
    if (t !== 0) return t;
    return b.id.localeCompare(a.id);
  });
  return sorted[0] ?? null;
}

export async function login(
  db: Database,
  username: string,
  password: string,
  jwtSecretKey: string,
  expiries: Pick<AuthTokenExpiries, "accessTokenExpiry" | "refreshTokenExpiry">,
) {
  const [user] = await db.select().from(users).where(eq(users.username, username)).limit(1);

  if (!user || user.status !== "active") {
    throw new UnauthorizedError("Invalid username or password");
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    throw new UnauthorizedError("Invalid username or password");
  }

  // The user MUST have at least one active membership to log in. The
  // default org for the web client is derived from `/me` later; we keep
  // the existence check here so a user with zero memberships gets a clear
  // 401 instead of silently ending up at a no-op landing page.
  const [member] = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.userId, user.id), eq(members.status, "active")))
    .orderBy(desc(members.createdAt), desc(members.id))
    .limit(1);

  if (!member) {
    throw new UnauthorizedError("No organization membership found");
  }

  const tokens = await signTokensForUser(jwtSecretKey, user.id, expiries);

  await db.update(users).set({ updatedAt: new Date() }).where(eq(users.id, user.id));

  return tokens;
}

/**
 * Refresh an access token. Sliding-window: the response also carries a
 * fresh refresh token whose lifetime restarts from now.
 */
export async function refreshAccessToken(
  db: Database,
  refreshToken: string,
  jwtSecretKey: string,
  expiries: Pick<AuthTokenExpiries, "accessTokenExpiry" | "refreshTokenExpiry">,
): Promise<{ accessToken: string; refreshToken: string }> {
  const secret = new TextEncoder().encode(jwtSecretKey);

  let payload: TokenPayload;
  try {
    const { payload: p } = await jwtVerify(refreshToken, secret);
    payload = p as unknown as TokenPayload;
  } catch (err) {
    // see jwt-trace.ts for the trace-only safety contract
    const untrusted = decodeJwtForTrace(refreshToken);
    throw new UnauthorizedError("Invalid or expired refresh token", {
      "auth.refresh.reason": classifyJoseError(err),
      ...untrustedAttrs("auth.refresh", untrusted),
    });
  }

  if (payload.type !== "refresh" || !payload.sub) {
    throw new UnauthorizedError("Invalid token type", {
      "auth.refresh.reason": "wrong_token_type",
      "auth.refresh.actual_type": String(payload.type ?? "<missing>"),
    });
  }

  const [user] = await db
    .select({ id: users.id, status: users.status })
    .from(users)
    .where(eq(users.id, payload.sub))
    .limit(1);

  if (!user) {
    throw new UnauthorizedError("User not found or suspended", {
      "auth.refresh.reason": "user_not_found",
      "auth.refresh.user_id": payload.sub,
    });
  }
  if (user.status !== "active") {
    throw new UnauthorizedError("User not found or suspended", {
      "auth.refresh.reason": "user_suspended",
      "auth.refresh.user_id": payload.sub,
      "auth.refresh.user_status": user.status,
    });
  }

  // Confirm the user still has at least one active membership; otherwise
  // refreshing would yield a token that lets them call /me but every
  // org-scoped route would 403. Surface the "you've been removed" state
  // at refresh time so the client redirects to login cleanly.
  const [anyMember] = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.userId, user.id), eq(members.status, "active")))
    .limit(1);

  if (!anyMember) {
    throw new UnauthorizedError("No active membership", {
      "auth.refresh.reason": "no_active_membership",
      "auth.refresh.user_id": payload.sub,
    });
  }

  return signTokensForUser(jwtSecretKey, user.id, expiries);
}

/**
 * Generate a short-lived connect token for CLI authentication.
 */
export async function generateConnectToken(
  userId: string,
  jwtSecretKey: string,
  expiries: Pick<AuthTokenExpiries, "connectTokenExpiry">,
  iss?: string,
): Promise<{ token: string; expiresIn: number }> {
  const secret = new TextEncoder().encode(jwtSecretKey);
  const jti = randomUUID();
  const builder = new SignJWT({ sub: userId, type: "connect" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setJti(jti)
    .setExpirationTime(expiries.connectTokenExpiry);
  if (iss) builder.setIssuer(iss);
  const token = await builder.sign(secret);
  return { token, expiresIn: expiryToSeconds(expiries.connectTokenExpiry) };
}

/**
 * Exchange a connect token for full access+refresh tokens.
 */
export async function exchangeConnectToken(
  db: Database,
  connectToken: string,
  jwtSecretKey: string,
  expiries: Pick<AuthTokenExpiries, "accessTokenExpiry" | "refreshTokenExpiry">,
): Promise<{ accessToken: string; refreshToken: string }> {
  const secret = new TextEncoder().encode(jwtSecretKey);

  let payload: TokenPayload;
  try {
    const { payload: p } = await jwtVerify(connectToken, secret);
    payload = p as unknown as TokenPayload;
  } catch (err) {
    const untrusted = decodeJwtForTrace(connectToken);
    throw new UnauthorizedError("Invalid or expired connect token", {
      "auth.connect.reason": classifyJoseError(err),
      ...untrustedAttrs("auth.connect", untrusted),
    });
  }

  if (payload.type !== "connect" || !payload.sub) {
    throw new UnauthorizedError("Invalid token type — expected connect token", {
      "auth.connect.reason": "wrong_token_type",
      "auth.connect.actual_type": String(payload.type ?? "<missing>"),
    });
  }

  const jti = (payload as unknown as Record<string, unknown>).jti as string | undefined;
  if (jti) {
    if (consumedConnectJtis.has(jti)) {
      throw new UnauthorizedError("Connect token has already been used");
    }
    consumedConnectJtis.set(jti, Date.now());
    const cutoff = Date.now() - CONNECT_JTI_TTL_MS;
    for (const [k, ts] of consumedConnectJtis) {
      if (ts < cutoff) consumedConnectJtis.delete(k);
    }
  }

  const [user] = await db
    .select({ id: users.id, status: users.status })
    .from(users)
    .where(eq(users.id, payload.sub))
    .limit(1);

  if (!user || user.status !== "active") {
    throw new UnauthorizedError("User not found or suspended");
  }

  // Same membership-existence check as refreshAccessToken — clear failure
  // mode if the connect token was minted before the user was removed.
  const [anyMember] = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.userId, user.id), eq(members.status, "active")))
    .limit(1);

  if (!anyMember) {
    throw new UnauthorizedError("No active membership");
  }

  return signTokensForUser(jwtSecretKey, user.id, expiries);
}
