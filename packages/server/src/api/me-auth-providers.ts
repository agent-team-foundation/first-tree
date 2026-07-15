import { randomBytes } from "node:crypto";
import { authProviderParamsSchema } from "@first-tree/shared";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { authIdentities } from "../db/schema/auth-identities.js";
import { requireUser } from "../scope/require-user.js";
import { buildAppAuthorizeUrl } from "../services/github-app.js";
import { buildGoogleAuthorizeUrl } from "../services/google-oauth.js";
import { OAUTH_STATE_COOKIE, OAUTH_STATE_COOKIE_MAX_AGE_S, signOAuthState } from "../services/oauth-state.js";
import { resolvePublicUrl } from "../utils/public-url.js";
import { buildCookie } from "./auth/oauth-cookie.js";

export async function meAuthProviderRoutes(app: FastifyInstance): Promise<void> {
  app.get("/me/auth-providers", async (request) => {
    const { userId } = requireUser(request);
    const rows = await app.db
      .select({
        provider: authIdentities.provider,
        email: authIdentities.email,
        metadata: authIdentities.metadata,
        createdAt: authIdentities.createdAt,
      })
      .from(authIdentities)
      .where(eq(authIdentities.userId, userId));
    const connectedCount = rows.filter((row) => row.provider === "google" || row.provider === "github").length;
    return {
      providers: (["google", "github"] as const).map((provider) => {
        const row = rows.find((candidate) => candidate.provider === provider);
        const metadata = row?.metadata ?? {};
        return {
          provider,
          available: provider === "google" ? Boolean(app.config.oauth?.google) : Boolean(app.config.oauth?.githubApp),
          connected: Boolean(row),
          accountName: typeof metadata.accountName === "string" ? metadata.accountName : null,
          email: row?.email ?? null,
          avatarUrl: typeof metadata.avatarUrl === "string" ? metadata.avatarUrl : null,
          connectedAt: row?.createdAt.toISOString() ?? null,
          canUnlink: Boolean(row) && connectedCount > 1,
          unlinkBlockedReason: row && connectedCount <= 1 ? "last-provider" : null,
        };
      }),
    };
  });

  app.post("/me/auth-providers/:provider/link/start", async (request, reply) => {
    const { userId } = requireUser(request);
    const { provider } = authProviderParamsSchema.parse(request.params);
    return startProviderAction(app, request, reply, { provider, userId, intent: "link" });
  });

  app.post("/me/auth-providers/:provider/unlink/start", async (request, reply) => {
    const { userId } = requireUser(request);
    const { provider } = authProviderParamsSchema.parse(request.params);
    const [identity] = await app.db
      .select({ id: authIdentities.id })
      .from(authIdentities)
      .where(and(eq(authIdentities.userId, userId), eq(authIdentities.provider, provider)))
      .limit(1);
    if (!identity) return reply.status(404).send({ error: "Authentication provider is not connected" });
    const identities = await app.db
      .select({ id: authIdentities.id })
      .from(authIdentities)
      .where(eq(authIdentities.userId, userId));
    if (identities.length <= 1) {
      return reply
        .status(409)
        .send({ code: "last-provider", error: "Connect another provider before disconnecting this one" });
    }
    return startProviderAction(app, request, reply, {
      provider,
      userId,
      intent: "unlink",
    });
  });
}

async function startProviderAction(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  input: {
    provider: "google" | "github";
    userId: string;
    intent: "link" | "unlink";
  },
) {
  const publicUrl = resolvePublicUrl(app, request);
  const oidcNonce = input.provider === "google" ? randomBytes(24).toString("base64url") : undefined;
  const { token, nonce } = await signOAuthState(app.config.secrets.jwtSecret, "/user-settings", {
    ...input,
    oidcNonce,
  });
  // The cookie contains only a random, short-lived CSRF nonce. It is not a
  // credential and is protected with HttpOnly, SameSite=Lax, and Secure in
  // production; CodeQL otherwise mistakes the Set-Cookie header for storage.
  // codeql[js/clear-text-storage-of-sensitive-data]
  reply.header(
    "Set-Cookie",
    buildCookie({
      name: OAUTH_STATE_COOKIE,
      value: nonce,
      maxAge: OAUTH_STATE_COOKIE_MAX_AGE_S,
      secure: process.env.NODE_ENV === "production",
    }),
  );
  if (input.provider === "google") {
    const config = app.config.oauth?.google;
    if (!config) return reply.status(503).send({ code: "provider-not-configured", error: "Google is not configured" });
    return {
      redirectUrl: buildGoogleAuthorizeUrl({
        clientId: config.clientId,
        redirectUri: `${publicUrl}/api/v1/auth/google/callback`,
        state: token,
        nonce: oidcNonce ?? "",
      }),
    };
  }
  const config = app.config.oauth?.githubApp;
  if (!config) return reply.status(503).send({ code: "provider-not-configured", error: "GitHub is not configured" });
  return {
    redirectUrl: buildAppAuthorizeUrl({
      clientId: config.clientId,
      redirectUri: `${publicUrl}/api/v1/auth/github/callback`,
      state: token,
    }),
  };
}
