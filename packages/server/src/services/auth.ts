import { createHash, randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcrypt";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { jwtVerify, SignJWT } from "jose";
import type { Database } from "../db/connection.js";
import { connectCodes } from "../db/schema/connect-codes.js";
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
const CONNECT_CODE_BYTES = 16;

/**
 * JWT payload shape. Normal access/refresh/connect tokens carry only the user
 * identity — no org / member / role. The `agent_outbox` token is a narrow
 * route-scoped exception for workspace-only trial sandboxes: it may carry the
 * current agent/chat ids, and `userAuthHook` accepts it only for that agent's
 * message POST in that chat.
 */
type TokenPayload = {
  sub: string;
  type: "access" | "refresh" | "connect" | "agent_outbox";
  iss?: string;
  agentId?: string;
  chatId?: string;
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

function normalizeIssuer(issuer: string): string {
  try {
    return new URL(issuer).origin;
  } catch {
    return issuer.replace(/\/+$/, "");
  }
}

function generateConnectCode(): string {
  return randomBytes(CONNECT_CODE_BYTES).toString("base64url");
}

function hashConnectCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function buildConnectCodeUrl(issuer: string, code: string): string {
  return `${normalizeIssuer(issuer)}/connect/${code}`;
}

function parseConnectCodeToken(token: string): { issuer: string; code: string } | null {
  try {
    const url = new URL(token);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const match = /^\/connect\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname);
    if (!match?.[1]) return null;
    return { issuer: url.origin, code: match[1] };
  } catch {
    return null;
  }
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

export async function signAgentOutboxToken(
  jwtSecretKey: string,
  userId: string,
  scope: { agentId: string; chatId: string },
  expiry: string,
): Promise<string> {
  const secret = new TextEncoder().encode(jwtSecretKey);
  return signToken(secret, { sub: userId, type: "agent_outbox", agentId: scope.agentId, chatId: scope.chatId }, expiry);
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
 *
 * The public token is a short URL (`<issuer>/connect/<code>`), not a JWT.
 * The URL origin preserves the CLI's environment routing behavior while the
 * opaque code is hashed in PostgreSQL for restart-safe, single-use exchange.
 */
export async function generateConnectToken(
  db: Database,
  userId: string,
  expiries: Pick<AuthTokenExpiries, "connectTokenExpiry">,
  issuer: string,
): Promise<{ token: string; expiresIn: number }> {
  const expiresIn = expiryToSeconds(expiries.connectTokenExpiry);
  const code = generateConnectCode();
  await db.insert(connectCodes).values({
    id: randomUUID(),
    codeHash: hashConnectCode(code),
    userId,
    issuer: normalizeIssuer(issuer),
    expiresAt: new Date(Date.now() + expiresIn * 1000),
  });
  return { token: buildConnectCodeUrl(issuer, code), expiresIn };
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
  const codeToken = parseConnectCodeToken(connectToken);
  if (codeToken) {
    const now = new Date();
    const [row] = await db
      .update(connectCodes)
      .set({ consumedAt: now })
      .where(
        and(
          eq(connectCodes.codeHash, hashConnectCode(codeToken.code)),
          eq(connectCodes.issuer, codeToken.issuer),
          isNull(connectCodes.consumedAt),
          gt(connectCodes.expiresAt, now),
        ),
      )
      .returning({ userId: connectCodes.userId });

    if (!row) {
      throw new UnauthorizedError("Invalid or expired connect token", {
        "auth.connect.reason": "code_invalid_or_expired",
      });
    }

    return signTokensForActiveUser(db, row.userId, jwtSecretKey, expiries, "auth.connect");
  }

  return exchangeLegacyConnectJwt(db, connectToken, jwtSecretKey, expiries);
}

async function exchangeLegacyConnectJwt(
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

  return signTokensForActiveUser(db, payload.sub, jwtSecretKey, expiries, "auth.connect");
}

async function signTokensForActiveUser(
  db: Database,
  userId: string,
  jwtSecretKey: string,
  expiries: Pick<AuthTokenExpiries, "accessTokenExpiry" | "refreshTokenExpiry">,
  attrPrefix: "auth.connect" | "auth.refresh",
): Promise<{ accessToken: string; refreshToken: string }> {
  const [user] = await db
    .select({ id: users.id, status: users.status })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user || user.status !== "active") {
    throw new UnauthorizedError("User not found or suspended", {
      [`${attrPrefix}.reason`]: user ? "user_suspended" : "user_not_found",
      [`${attrPrefix}.user_id`]: userId,
      ...(user ? { [`${attrPrefix}.user_status`]: user.status } : {}),
    });
  }

  // Same membership-existence check as refreshAccessToken — clear failure
  // mode if the connect token was minted before the user was removed.
  const [anyMember] = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.userId, userId), eq(members.status, "active")))
    .limit(1);

  if (!anyMember) {
    throw new UnauthorizedError("No active membership", {
      [`${attrPrefix}.reason`]: "no_active_membership",
      [`${attrPrefix}.user_id`]: userId,
    });
  }

  return signTokensForUser(jwtSecretKey, userId, expiries);
}
