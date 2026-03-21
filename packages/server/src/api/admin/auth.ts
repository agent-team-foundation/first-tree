import { loginSchema, refreshTokenSchema } from "@agent-hub/shared";
import type { FastifyInstance } from "fastify";
import * as adminAuthService from "../../services/admin-auth.js";

export async function adminAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post("/login", async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const result = await adminAuthService.login(app.db, body.username, body.password, app.config.jwtSecretKey);
    return reply.send(result);
  });

  app.post("/refresh", async (request, reply) => {
    const body = refreshTokenSchema.parse(request.body);
    const result = await adminAuthService.refreshAccessToken(app.db, body.refreshToken, app.config.jwtSecretKey);
    return reply.send(result);
  });
}
