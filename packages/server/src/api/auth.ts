import {
  connectTokenExchangeSchema,
  loginSchema,
  refreshTokenSchema,
} from "@agent-team-foundation/first-tree-hub-shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { UnauthorizedError } from "../errors.js";
import * as authService from "../services/auth.js";

const LOOPBACK_IPS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Three-gate middleware (Q7 / A1) for the loopback-only `local-bootstrap`
 * endpoint:
 *
 *   1. `req.ip` ∈ {127.0.0.1, ::1, ::ffff:127.0.0.1} — TCP-level loopback.
 *   2. No `X-Forwarded-*` or `Forwarded` (RFC 7239) header — defends
 *      against a reverse proxy in front of the daemon stripping the
 *      loopback signal.
 *   3. `Host` header matches `127.0.0.1:<port>` or `localhost:<port>`
 *      using the runtime config's bound port — defends against DNS
 *      rebinding, which is the only attack class CORS can't catch on its
 *      own (the browser sees the response as same-origin once DNS
 *      rebinds; only `Host` reveals the spoof).
 *
 * Failures all return 401 — there's no tier of "wrong but allowed", and
 * a uniform error doesn't telegraph which gate tripped.
 */
function assertLocalAccess(request: FastifyRequest, port: number): void {
  if (!LOOPBACK_IPS.has(request.ip)) {
    throw new UnauthorizedError("local-bootstrap requires loopback access");
  }

  // Fastify already lower-cases header names; no extra lowering needed.
  for (const header in request.headers) {
    if (header.startsWith("x-forwarded-") || header === "forwarded") {
      throw new UnauthorizedError("local-bootstrap rejects forwarded requests");
    }
  }

  const hostHeader = request.headers.host;
  if (typeof hostHeader !== "string" || hostHeader.length === 0) {
    throw new UnauthorizedError("local-bootstrap requires a Host header");
  }
  const expectedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!expectedHosts.has(hostHeader.toLowerCase())) {
    throw new UnauthorizedError("local-bootstrap host check failed");
  }
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const loginMax = app.config.rateLimit?.loginMax ?? 5;

  app.post("/login", { config: { rateLimit: { max: loginMax, timeWindow: "1 minute" } } }, async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const result = await authService.login(app.db, body.username, body.password, app.config.secrets.jwtSecret);
    return reply.send(result);
  });

  app.post("/refresh", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
    const body = refreshTokenSchema.parse(request.body);
    const result = await authService.refreshAccessToken(app.db, body.refreshToken, app.config.secrets.jwtSecret);
    return reply.send(result);
  });

  app.post(
    "/connect-token",
    { config: { rateLimit: { max: loginMax, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const body = connectTokenExchangeSchema.parse(request.body);
      const result = await authService.exchangeConnectToken(app.db, body.token, app.config.secrets.jwtSecret);
      return reply.send(result);
    },
  );

  // Q7: loopback-trust admin minting. Hosted-mode deployments set
  // FIRST_TREE_HUB_DISABLE_LOCAL_BOOTSTRAP=1 — the route isn't registered,
  // so a probe returns a clean 404.
  if (process.env.FIRST_TREE_HUB_DISABLE_LOCAL_BOOTSTRAP !== "1") {
    const port = app.config.server.port;
    app.post(
      "/local-bootstrap",
      { config: { rateLimit: { max: loginMax, timeWindow: "1 minute" } } },
      async (request: FastifyRequest, reply: FastifyReply) => {
        assertLocalAccess(request, port);
        const result = await authService.localBootstrap(app.db, app.config.secrets.jwtSecret);
        return reply.send(result);
      },
    );
  }
}
