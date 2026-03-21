import bcrypt from "bcrypt";
import { eq } from "drizzle-orm";
import { jwtVerify, SignJWT } from "jose";
import type { Database } from "../db/connection.js";
import { adminUsers } from "../db/schema/admin-users.js";
import { UnauthorizedError } from "../errors.js";

const ACCESS_TOKEN_EXPIRY = "30m";
const REFRESH_TOKEN_EXPIRY = "7d";

async function signToken(secret: Uint8Array, sub: string, type: "access" | "refresh", expiry: string): Promise<string> {
  return new SignJWT({ sub, type })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(expiry)
    .sign(secret);
}

export async function login(db: Database, username: string, password: string, jwtSecretKey: string) {
  const [user] = await db.select().from(adminUsers).where(eq(adminUsers.username, username)).limit(1);

  if (!user) {
    throw new UnauthorizedError("Invalid username or password");
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    throw new UnauthorizedError("Invalid username or password");
  }

  const secret = new TextEncoder().encode(jwtSecretKey);
  const accessToken = await signToken(secret, user.id, "access", ACCESS_TOKEN_EXPIRY);
  const refreshToken = await signToken(secret, user.id, "refresh", REFRESH_TOKEN_EXPIRY);

  // Update last_login_at
  await db.update(adminUsers).set({ lastLoginAt: new Date() }).where(eq(adminUsers.id, user.id));

  return { accessToken, refreshToken };
}

export async function refreshAccessToken(db: Database, refreshToken: string, jwtSecretKey: string) {
  const secret = new TextEncoder().encode(jwtSecretKey);

  let payload: { sub?: string; type?: string };
  try {
    const { payload: p } = await jwtVerify(refreshToken, secret);
    payload = p as { sub?: string; type?: string };
  } catch {
    throw new UnauthorizedError("Invalid or expired refresh token");
  }

  if (payload.type !== "refresh" || !payload.sub) {
    throw new UnauthorizedError("Invalid token type");
  }

  // Verify admin still exists
  const [admin] = await db
    .select({ id: adminUsers.id })
    .from(adminUsers)
    .where(eq(adminUsers.id, payload.sub))
    .limit(1);

  if (!admin) {
    throw new UnauthorizedError("Admin user not found");
  }

  const accessToken = await signToken(secret, admin.id, "access", ACCESS_TOKEN_EXPIRY);
  return { accessToken };
}
