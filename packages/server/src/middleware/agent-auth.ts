import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Database } from "../db/connection.js";
import { agentTokens } from "../db/schema/agent-tokens.js";
import { agents } from "../db/schema/agents.js";
import { UnauthorizedError } from "../errors.js";

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function agentAuthHook(db: Database) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw new UnauthorizedError("Missing or invalid Authorization header");
    }

    const raw = header.slice(7);
    if (!raw.startsWith("aghub_")) {
      throw new UnauthorizedError("Invalid token format");
    }

    const hash = hashToken(raw);
    const now = new Date();

    const [tokenRow] = await db
      .select({ agentId: agentTokens.agentId, tokenId: agentTokens.id })
      .from(agentTokens)
      .where(and(eq(agentTokens.tokenHash, hash), isNull(agentTokens.revokedAt)))
      .limit(1);

    if (!tokenRow) {
      throw new UnauthorizedError("Invalid or revoked token");
    }

    // Check expiration in application layer (nullable expiresAt = no expiration)
    const [tokenDetail] = await db
      .select({ expiresAt: agentTokens.expiresAt })
      .from(agentTokens)
      .where(eq(agentTokens.id, tokenRow.tokenId))
      .limit(1);

    if (tokenDetail?.expiresAt && tokenDetail.expiresAt < now) {
      throw new UnauthorizedError("Token has expired");
    }

    const [agent] = await db
      .select({
        uuid: agents.uuid,
        name: agents.name,
        organizationId: agents.organizationId,
        inboxId: agents.inboxId,
      })
      .from(agents)
      .where(and(eq(agents.uuid, tokenRow.agentId), eq(agents.status, "active")))
      .limit(1);

    if (!agent) {
      throw new UnauthorizedError("Agent is suspended or not found");
    }

    // Update last_used_at (fire-and-forget)
    db.update(agentTokens)
      .set({ lastUsedAt: now })
      .where(eq(agentTokens.id, tokenRow.tokenId))
      .then(
        () => {},
        () => {},
      );

    request.agent = agent;
  };
}
