import { loginSchema, refreshTokenSchema } from "@agent-hub/shared";
import type { FastifyInstance } from "fastify";
import * as adminAuthService from "../../services/admin-auth.js";

export async function adminAuthRoutes(app: FastifyInstance): Promise<void> {
  const loginMax = Number(process.env.AGENT_HUB_RATE_LIMIT_LOGIN_MAX) || 5;

  app.post("/login", { config: { rateLimit: { max: loginMax, timeWindow: "1 minute" } } }, async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const result = await adminAuthService.login(app.db, body.username, body.password, app.config.secrets.jwtSecret);
    return reply.send(result);
  });

  app.post("/refresh", async (request, reply) => {
    const body = refreshTokenSchema.parse(request.body);
    const result = await adminAuthService.refreshAccessToken(app.db, body.refreshToken, app.config.secrets.jwtSecret);
    return reply.send(result);
  });
}
