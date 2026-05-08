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
      throw new UnauthorizedError("Missing or invalid Authorization header", {
        "auth.failure_reason": "missing_authorization_header",
      });
    }

    const token = header.slice(7);

    let payload: { sub?: string; memberId?: string; organizationId?: string; role?: string; type?: string };
    try {
      const { payload: p } = await jwtVerify(token, secret);
      payload = p as typeof payload;
    } catch {
      // jwtVerify lumps "expired" / "tampered" / "wrong secret" into one
      // error — recording the outcome (verify rejection) is still enough
      // for operators to triage with `client.ip` (if opted in) + ua.
      throw new UnauthorizedError("Invalid or expired token", {
        "auth.failure_reason": "jwt_verify_failed",
      });
    }

    if (payload.type !== "access" || !payload.sub || !payload.memberId) {
      throw new UnauthorizedError("Invalid token type", {
        "auth.failure_reason": "wrong_token_type",
        "auth.token_type": String(payload.type ?? "<missing>"),
      });
    }

    // Verify user still exists and is active
    const [user] = await db
      .select({ id: users.id, status: users.status })
      .from(users)
      .where(eq(users.id, payload.sub))
      .limit(1);

    if (!user) {
      throw new UnauthorizedError("User not found or suspended", {
        "auth.failure_reason": "user_not_found",
        "auth.user_id": payload.sub,
      });
    }
    if (user.status !== "active") {
      throw new UnauthorizedError("User not found or suspended", {
        "auth.failure_reason": "user_suspended",
        "auth.user_id": payload.sub,
        "auth.user_status": user.status,
      });
    }

    // Verify membership still exists and hasn't been soft-deleted via "leave team".
    const [member] = await db
      .select({
        id: members.id,
        organizationId: members.organizationId,
        role: members.role,
        agentId: members.agentId,
        status: members.status,
      })
      .from(members)
      .where(eq(members.id, payload.memberId))
      .limit(1);

    if (!member || member.status !== "active") {
      throw new UnauthorizedError("Membership not found", {
        "auth.failure_reason": member ? "membership_inactive" : "membership_not_found",
        "auth.user_id": payload.sub,
        "auth.member_id": payload.memberId,
        ...(member ? { "auth.member_status": member.status } : {}),
      });
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
      throw new ForbiddenError("Admin role required", {
        "auth.failure_reason": "admin_role_required",
        ...(request.member
          ? {
              "auth.user_id": request.member.userId,
              "auth.member_id": request.member.memberId,
              "auth.user_role": request.member.role,
            }
          : {}),
      });
    }
  };
}
