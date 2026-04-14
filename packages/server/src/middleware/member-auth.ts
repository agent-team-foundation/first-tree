import { eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { jwtVerify } from "jose";
import type { Database } from "../db/connection.js";
import { members } from "../db/schema/members.js";
import { users } from "../db/schema/users.js";
import { ForbiddenError, UnauthorizedError } from "../errors.js";

export function memberAuthHook(db: Database, jwtSecret: string) {
  const secret = new TextEncoder().encode(jwtSecret);

  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw new UnauthorizedError("Missing or invalid Authorization header");
    }

    const token = header.slice(7);

    let payload: { sub?: string; memberId?: string; organizationId?: string; role?: string; type?: string };
    try {
      const { payload: p } = await jwtVerify(token, secret);
      payload = p as typeof payload;
    } catch {
      throw new UnauthorizedError("Invalid or expired token");
    }

    if (payload.type !== "access" || !payload.sub || !payload.memberId) {
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
    const [member] = await db
      .select({
        id: members.id,
        organizationId: members.organizationId,
        role: members.role,
        agentId: members.agentId,
      })
      .from(members)
      .where(eq(members.id, payload.memberId))
      .limit(1);

    if (!member) {
      throw new UnauthorizedError("Membership not found");
    }

    request.member = {
      userId: user.id,
      memberId: member.id,
      organizationId: member.organizationId,
      role: member.role,
      agentId: member.agentId,
    };
  };
}

/** Additional hook that requires admin role. Use after memberAuthHook. */
export function requireAdminRoleHook() {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (request.member?.role !== "admin") {
      throw new ForbiddenError("Admin role required");
    }
  };
}
