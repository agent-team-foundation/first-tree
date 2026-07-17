import { randomBytes } from "node:crypto";
import { authProviderParamsSchema } from "@first-tree/shared";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { authIdentities } from "../db/schema/auth-identities.js";
import { users } from "../db/schema/users.js";
import { requireUser } from "../scope/require-user.js";
import {
  type AuthCredentialSnapshot,
  type AuthProviderAvailability,
  hasUsableAuthentication,
} from "../services/auth-identity.js";
import { buildAppAuthorizeUrl } from "../services/github-app.js";
import { buildGoogleAuthorizeUrl } from "../services/google-oauth.js";
import { OAUTH_STATE_COOKIE, OAUTH_STATE_COOKIE_MAX_AGE_S, signOAuthState } from "../services/oauth-state.js";
import { resolvePublicUrl } from "../utils/public-url.js";
import { buildCookie, protectOAuthStateNonce } from "./auth/oauth-cookie.js";

// OAuth link/unlink flows return the browser to the legacy /user-settings
// path on purpose: rolling deploys keep pre-Account SPA builds (which have no
// /settings/account route) in circulation, while the new SPA redirects
// /user-settings -> /settings/account with the query string intact, so both
// generations land on a working page. Switch this to /settings/account only
// once pre-Account SPA builds are out of circulation.
const ACCOUNT_RETURN_PATH = "/user-settings";

export async function meAuthProviderRoutes(app: FastifyInstance): Promise<void> {
  app.get("/me/auth-providers", async (request) => {
    const { userId } = requireUser(request);
    const availability = configuredProviders(app);
    const [user] = await app.db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) throw new Error("Authenticated user is missing");
    const rows = await app.db
      .select({
        provider: authIdentities.provider,
        identifier: authIdentities.identifier,
        credentialType: authIdentities.credentialType,
        email: authIdentities.email,
        metadata: authIdentities.metadata,
        createdAt: authIdentities.createdAt,
      })
      .from(authIdentities)
      .where(eq(authIdentities.userId, userId));
    const snapshots: AuthCredentialSnapshot[] = rows.map((row) => ({
      provider: row.provider,
      identifier: row.identifier,
      credentialType: row.credentialType,
    }));
    return {
      providers: (["google", "github"] as const).map((provider) => {
        const row = rows.find((candidate) => candidate.provider === provider);
        const metadata = row?.metadata ?? {};
        const canUnlink =
          Boolean(row) &&
          availability[provider] &&
          hasUsableAuthentication(snapshots, user.passwordHash, availability, provider);
        return {
          provider,
          available: availability[provider],
          connected: Boolean(row),
          accountName: typeof metadata.accountName === "string" ? metadata.accountName : null,
          email: row?.email ?? null,
          avatarUrl: typeof metadata.avatarUrl === "string" ? metadata.avatarUrl : null,
          connectedAt: row?.createdAt.toISOString() ?? null,
          canUnlink,
          unlinkBlockedReason: row && !canUnlink && availability[provider] ? "last-provider" : null,
        };
      }),
    };
  });

  app.post(
    "/me/auth-providers/:provider/link/start",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { userId } = requireUser(request);
      const { provider } = authProviderParamsSchema.parse(request.params);
      return startProviderAction(app, request, reply, { provider, userId, intent: "link" });
    },
  );

  app.post(
    "/me/auth-providers/:provider/unlink/start",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { userId } = requireUser(request);
      const { provider } = authProviderParamsSchema.parse(request.params);
      const availability = configuredProviders(app);
      const [identity] = await app.db
        .select({ id: authIdentities.id, provider: authIdentities.provider })
        .from(authIdentities)
        .where(and(eq(authIdentities.userId, userId), eq(authIdentities.provider, provider)))
        .limit(1);
      if (!identity) return reply.status(404).send({ error: "Authentication provider is not connected" });
      if (!availability[provider]) {
        return reply
          .status(503)
          .send({ code: "provider-not-configured", error: "Authentication provider is not configured" });
      }
      const [user] = await app.db
        .select({ passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      const identities = await app.db
        .select({
          provider: authIdentities.provider,
          identifier: authIdentities.identifier,
          credentialType: authIdentities.credentialType,
        })
        .from(authIdentities)
        .where(eq(authIdentities.userId, userId));
      if (!user || !hasUsableAuthentication(identities, user.passwordHash, availability, provider)) {
        return reply
          .status(409)
          .send({ code: "last-provider", error: "Connect another provider before disconnecting this one" });
      }
      return startProviderAction(app, request, reply, {
        provider,
        userId,
        intent: "unlink",
        targetIdentityId: identity.id,
      });
    },
  );
}

async function startProviderAction(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  input: {
    provider: "google" | "github";
    userId: string;
    intent: "link" | "unlink";
    targetIdentityId?: string;
  },
) {
  const availability = configuredProviders(app);
  if (!availability[input.provider]) {
    return reply
      .status(503)
      .send({ code: "provider-not-configured", error: "Authentication provider is not configured" });
  }
  const publicUrl = resolvePublicUrl(app, request);
  const oidcNonce = input.provider === "google" ? randomBytes(24).toString("base64url") : undefined;
  const { token, nonce } = await signOAuthState(app.config.secrets.jwtSecret, ACCOUNT_RETURN_PATH, {
    ...input,
    oidcNonce,
  });
  // Encrypt the nonce before placing it in the browser cookie. The callback
  // accepts legacy plaintext nonce cookies during rolling deployments.
  // The value is a nonce-only CSRF token, not a credential; it is short-lived,
  // HttpOnly, SameSite=Lax, and Secure in production. CodeQL otherwise treats
  // the Set-Cookie sink as clear-text storage.
  // codeql[js/clear-text-storage-of-sensitive-data]
  reply.header(
    "Set-Cookie",
    buildCookie({
      name: OAUTH_STATE_COOKIE,
      value: protectOAuthStateNonce(nonce, app.config.secrets.encryptionKey),
      maxAge: OAUTH_STATE_COOKIE_MAX_AGE_S,
      secure: process.env.NODE_ENV === "production",
    }),
  );
  if (input.provider === "google") {
    const config = app.config.oauth?.google;
    if (!config) throw new Error("Google provider availability drifted during OAuth start");
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
  if (!config) throw new Error("GitHub provider availability drifted during OAuth start");
  return {
    redirectUrl: buildAppAuthorizeUrl({
      clientId: config.clientId,
      redirectUri: `${publicUrl}/api/v1/auth/github/callback`,
      state: token,
    }),
  };
}

function configuredProviders(app: FastifyInstance): AuthProviderAvailability {
  return {
    google: Boolean(app.config.oauth?.google),
    github: Boolean(app.config.oauth?.githubApp),
  };
}
