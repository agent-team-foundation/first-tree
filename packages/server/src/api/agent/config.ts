import type { FastifyInstance } from "fastify";
import { requireAgent } from "../../middleware/require-identity.js";

/**
 * Agent-facing runtime config endpoint (Step 4).
 *
 * The agent's own bearer token authenticates the request. Sensitive env
 * values are returned in plaintext — the runtime needs them to launch its
 * subprocess. The token holder already has full agent privileges, so
 * exposing values to the token bearer matches the security model.
 */
export async function agentConfigRoutes(app: FastifyInstance): Promise<void> {
  app.get("/config", async (request) => {
    const identity = requireAgent(request);
    const cfg = await app.configService.getDecrypted(identity.uuid);
    return cfg;
  });
}
