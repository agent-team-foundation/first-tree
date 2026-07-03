import { AGENT_SELECTOR_HEADER } from "@first-tree/shared";
import { eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { jwtVerify } from "jose";
import type { Database } from "../db/connection.js";
import { users } from "../db/schema/users.js";
import { UnauthorizedError } from "../errors.js";
import { classifyJoseError, decodeJwtForTrace, untrustedAttrs } from "../observability/jwt-trace.js";

/**
 * Replaces `memberAuthHook`. Verifies the JWT, confirms the user is still
 * active, and populates `request.user = { userId }`. The auth payload is
 * intentionally narrow — anything beyond `userId` (org / role / member)
 * is resolved per-request via the `scope/require-*` helpers.
 *
 * Forward-compat: legacy access tokens that still carry
 * `memberId / organizationId / role` continue to validate, because we only
 * read `sub` and `type`. The extra fields are ignored.
 */
export function userAuthHook(db: Database, jwtSecret: string) {
  const secret = new TextEncoder().encode(jwtSecret);

  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw new UnauthorizedError("Missing or invalid Authorization header", {
        "auth.failure_reason": "missing_authorization_header",
      });
    }

    const token = header.slice(7);

    let payload: { sub?: string; type?: string; agentId?: unknown; chatId?: unknown };
    try {
      const { payload: p } = await jwtVerify(token, secret);
      payload = p as typeof payload & { agentId?: unknown; chatId?: unknown };
    } catch (err) {
      // see jwt-trace.ts for the trace-only safety contract
      const untrusted = decodeJwtForTrace(token);
      throw new UnauthorizedError("Invalid or expired token", {
        "auth.failure_reason": classifyJoseError(err),
        ...untrustedAttrs("auth", untrusted),
      });
    }

    if ((payload.type !== "access" && payload.type !== "agent_outbox") || !payload.sub) {
      throw new UnauthorizedError("Invalid token type", {
        "auth.failure_reason": "wrong_token_type",
        "auth.token_type": String(payload.type ?? "<missing>"),
      });
    }

    const agentOutbox = payload.type === "agent_outbox" ? parseAgentOutboxScope(payload.agentId, payload.chatId) : null;
    if (payload.type === "agent_outbox" && !agentOutbox) {
      throw new UnauthorizedError("Invalid agent outbox token", {
        "auth.failure_reason": "invalid_agent_outbox_scope",
      });
    }
    if (agentOutbox && !isAllowedAgentOutboxRequest(request, agentOutbox)) {
      throw new UnauthorizedError("Agent outbox token is not valid for this request", {
        "auth.failure_reason": "agent_outbox_scope_mismatch",
      });
    }

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

    request.user = agentOutbox ? { userId: user.id, agentOutbox } : { userId: user.id };
  };
}

function parseAgentOutboxScope(agentId: unknown, chatId: unknown): { agentId: string; chatId: string } | null {
  if (typeof agentId !== "string" || agentId.length === 0) return null;
  if (typeof chatId !== "string" || chatId.length === 0) return null;
  return { agentId, chatId };
}

function isAllowedAgentOutboxRequest(request: FastifyRequest, scope: { agentId: string; chatId: string }): boolean {
  if (request.method !== "POST") return false;
  if (request.headers[AGENT_SELECTOR_HEADER] !== scope.agentId) return false;

  const pathname = new URL(request.url, "http://first-tree.local").pathname;
  const marker = "/agent/chats/";
  const markerIndex = pathname.indexOf(marker);
  if (markerIndex < 0) return false;
  const tail = pathname.slice(markerIndex + marker.length);
  const parts = tail.split("/");
  if (parts.length !== 2 || parts[1] !== "messages") return false;
  try {
    return decodeURIComponent(parts[0] ?? "") === scope.chatId;
  } catch {
    return false;
  }
}
