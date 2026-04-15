import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { agents } from "../db/schema/agents.js";
import { users } from "../db/schema/users.js";
import { requireMember } from "../middleware/require-identity.js";

/** GET /me — returns current user + member + agent info. */
export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.get("/me", async (request) => {
    const m = requireMember(request);

    const [user] = await app.db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
      })
      .from(users)
      .where(eq(users.id, m.userId))
      .limit(1);

    const [agent] = await app.db
      .select({
        uuid: agents.uuid,
        name: agents.name,
        displayName: agents.displayName,
        inboxId: agents.inboxId,
      })
      .from(agents)
      .where(eq(agents.uuid, m.agentId))
      .limit(1);

    return {
      user: user ?? null,
      member: {
        id: m.memberId,
        organizationId: m.organizationId,
        role: m.role,
        agentId: m.agentId,
      },
      agent: agent ?? null,
    };
  });
}
