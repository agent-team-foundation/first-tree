import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { UnauthorizedError } from "../errors.js";
import { pickDefaultMembership, signTokensForMember, signUserTokens } from "../services/auth.js";
import {
  buildGithubAuthorizeUrl,
  exchangeGithubCode,
  findOrCreateUserViaGithub,
  type GithubProfile,
  resolveRedirectUri,
  signOauthState,
  verifyOauthState,
} from "../services/auth-github.js";

/**
 * GitHub OAuth surface — `start`, `callback`, and a `dev-callback` stub
 * that fires when no `oauth.github` is configured. The dev path is only
 * registered when client credentials are absent so production deployments
 * can never accidentally accept a forged identity through it.
 *
 * Sign-in resolution order on a successful callback:
 *   1. lookup-or-create the user via `auth_providers`
 *   2. pick the user's most-recent membership; if none, mint a `type: "user"`
 *      token instead so the frontend can land on `/setup`
 *   3. honour `next=/invite/<token>` — return an absolute path the frontend
 *      can redirect to (the actual join still goes through
 *      `POST /me/workspaces/join`, which is callable with either token type)
 */

const startQuerySchema = z.object({
  /**
   * Where the frontend wants to land after sign-in. Restricted to relative
   * paths to keep the start endpoint from becoming an open redirect — any
   * absolute URL is silently dropped to `/`.
   */
  next: z
    .string()
    .optional()
    .transform((v) => (v?.startsWith("/") && !v.startsWith("//") ? v : "/")),
  // Dev-stub overrides — ignored in production. The frontend doesn't normally
  // pass these; tests do, and a curl-based local dev workflow can.
  dev_login: z.string().optional(),
  dev_email: z.string().optional(),
  dev_id: z.string().optional(),
});

const callbackQuerySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

const devCallbackQuerySchema = z.object({
  state: z.string().min(1),
  login: z.string().min(1),
  /** Numeric-stringified GitHub id; tests use predictable values. */
  github_id: z.string().min(1),
  email: z.string().optional(),
  display_name: z.string().optional(),
  avatar_url: z.string().optional(),
});

export async function authGithubRoutes(app: FastifyInstance): Promise<void> {
  const oauth = app.config.oauth?.github;
  const devMode = !oauth?.clientId || !oauth?.clientSecret;

  app.get("/start", async (request, reply) => {
    const query = startQuerySchema.parse(request.query);
    const { state } = await signOauthState(app.config.secrets.jwtSecret, query.next);
    const origin = readOrigin(request);

    if (devMode) {
      // Dev fallback — bounce straight to dev-callback with the supplied (or
      // defaulted) stub identity. Nothing here calls GitHub.
      const params = new URLSearchParams({
        state,
        login: query.dev_login ?? "devuser",
        github_id: query.dev_id ?? "100000",
        email: query.dev_email ?? "devuser@example.local",
        display_name: query.dev_login ?? "Dev User",
      });
      const url = `${origin.proto}://${origin.host}/api/v1/auth/github/dev-callback?${params.toString()}`;
      return reply.redirect(url, 302);
    }

    const redirectUri = resolveRedirectUri(oauth.redirectUri, origin);
    const authorizeUrl = buildGithubAuthorizeUrl(oauth.clientId, state, redirectUri);
    return reply.redirect(authorizeUrl, 302);
  });

  app.get("/callback", async (request, reply) => {
    if (devMode) {
      // The real GitHub never lands here in dev mode — refuse loudly so a
      // forgotten redirect URI doesn't silently fall through to nothing.
      throw new UnauthorizedError(
        "OAuth callback is disabled — server has no GitHub credentials configured. Use /dev-callback for local dev.",
      );
    }
    const query = callbackQuerySchema.parse(request.query);
    const { next } = await verifyOauthState(app.config.secrets.jwtSecret, query.state);
    const origin = readOrigin(request);
    const redirectUri = resolveRedirectUri(oauth?.redirectUri, origin);

    if (!oauth) {
      throw new UnauthorizedError("OAuth misconfigured");
    }
    const profile = await exchangeGithubCode(
      { clientId: oauth.clientId, clientSecret: oauth.clientSecret, redirectUri },
      query.code,
    );
    return completeSignIn(app, reply, profile, next);
  });

  if (devMode) {
    app.get("/dev-callback", async (request, reply) => {
      const query = devCallbackQuerySchema.parse(request.query);
      const { next } = await verifyOauthState(app.config.secrets.jwtSecret, query.state);
      const profile: GithubProfile = {
        githubId: query.github_id,
        login: query.login,
        email: query.email ?? "",
        displayName: query.display_name ?? query.login,
        avatarUrl: query.avatar_url ?? "",
      };
      return completeSignIn(app, reply, profile, next);
    });
  }
}

/**
 * Resolve a GitHub profile to a user, then issue tokens scoped either to
 * the user's most-recent membership (if any) or to a rootless user token.
 * Returns the JSON shape `signInResponseSchema` documents — the frontend
 * stashes the tokens and follows `nextRoute`.
 */
async function completeSignIn(
  app: FastifyInstance,
  reply: FastifyReply,
  profile: GithubProfile,
  next: string,
): Promise<FastifyReply> {
  const { userId } = await findOrCreateUserViaGithub(app.db, profile);
  const membership = await pickDefaultMembership(app.db, userId);

  const tokens = membership
    ? await signTokensForMember(
        {
          userId,
          memberId: membership.memberId,
          organizationId: membership.organizationId,
          role: membership.role,
        },
        app.config.secrets.jwtSecret,
      )
    : await signUserTokens(userId, app.config.secrets.jwtSecret);

  // Route resolution:
  //   * `next=/invite/<token>` — always honour, even when the user already
  //     has a workspace; clicking an invite link is an explicit intent to
  //     join *that* workspace.
  //   * No membership → /setup (Create / Join modal)
  //   * Membership → /  (the regular app shell, which handles the
  //     wizard-incomplete case via `members.onboarding_state` in PR #5)
  const nextRoute = next.startsWith("/invite/") ? next : membership ? "/" : "/setup";

  return reply.send({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    nextRoute,
  });
}

function readOrigin(request: FastifyRequest): { proto: string; host: string } {
  const proto = (request.headers["x-forwarded-proto"] as string | undefined) ?? request.protocol;
  const host =
    (request.headers["x-forwarded-host"] as string | undefined) ??
    (request.headers.host as string | undefined) ??
    request.hostname;
  return { proto, host };
}
