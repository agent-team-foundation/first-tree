import { eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { jwtVerify } from "jose";
import type { Database } from "../db/connection.js";
import { adminUsers } from "../db/schema/admin-users.js";
import { UnauthorizedError } from "../errors.js";

export function adminAuthHook(db: Database, jwtSecret: string) {
  const secret = new TextEncoder().encode(jwtSecret);

  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw new UnauthorizedError("Missing or invalid Authorization header");
    }

    const token = header.slice(7);

    let payload: { sub?: string; type?: string };
    try {
      const { payload: p } = await jwtVerify(token, secret);
      payload = p as { sub?: string; type?: string };
    } catch {
      throw new UnauthorizedError("Invalid or expired token");
    }

    if (payload.type !== "access" || !payload.sub) {
      throw new UnauthorizedError("Invalid token type");
    }

    const [admin] = await db
      .select({
        id: adminUsers.id,
        username: adminUsers.username,
        role: adminUsers.role,
      })
      .from(adminUsers)
      .where(eq(adminUsers.id, payload.sub))
      .limit(1);

    if (!admin) {
      throw new UnauthorizedError("Admin user not found");
    }

    request.admin = admin;
  };
}
