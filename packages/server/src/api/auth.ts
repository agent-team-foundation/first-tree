import { connectTokenExchangeSchema, loginSchema, refreshTokenSchema } from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import * as authService from "../services/auth.js";

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/login", { config: { otelRecordBody: true } }, async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const result = await authService.login(
      app.db,
      body.username,
      body.password,
      app.config.secrets.jwtSecret,
      app.config.auth,
    );
    return reply.send(result);
  });

  app.post("/refresh", { config: { otelRecordBody: true } }, async (request, reply) => {
    const body = refreshTokenSchema.parse(request.body);
    const result = await authService.refreshAccessToken(
      app.db,
      body.refreshToken,
      app.config.secrets.jwtSecret,
      app.config.auth,
    );
    return reply.send(result);
  });

  app.post("/connect-token", { config: { otelRecordBody: true } }, async (request, reply) => {
    const body = connectTokenExchangeSchema.parse(request.body);
    const result = await authService.exchangeConnectToken(
      app.db,
      body.token,
      app.config.secrets.jwtSecret,
      app.config.auth,
    );
    return reply.send(result);
  });
}
