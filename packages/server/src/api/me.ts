import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { agents } from "../db/schema/agents.js";
import { users } from "../db/schema/users.js";
import { requireMember } from "../middleware/require-identity.js";
import * as authService from "../services/auth.js";

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

  /**
   * POST /connect-tokens — generate a short-lived connect token for CLI authentication.
   * The token can be exchanged via POST /auth/connect-token for full credentials.
   */
  app.post("/connect-tokens", async (request) => {
    const m = requireMember(request);
    const { token, expiresIn } = await authService.generateConnectToken(
      { userId: m.userId, memberId: m.memberId, organizationId: m.organizationId, role: m.role },
      app.config.secrets.jwtSecret,
    );

    // Build the CLI connect command using the request's origin (preserve port)
    const proto = request.headers["x-forwarded-proto"] ?? request.protocol;
    const host = request.headers["x-forwarded-host"] ?? request.headers.host ?? request.hostname;
    const serverUrl = `${proto}://${host}`;
    const command = `first-tree-hub connect ${serverUrl} --token ${token}`;

    return { token, expiresIn, command };
  });
}
