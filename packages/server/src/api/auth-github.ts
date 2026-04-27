import { sanitizeNextPath } from "@agent-team-foundation/first-tree-hub-shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { UnauthorizedError } from "../errors.js";
import { pickDefaultMembership, signTokensForMember, signUserTokens } from "../services/auth.js";
import {
  buildGithubAuthorizeUrl,
  buildStateCookie,
  clearStateCookie,
  exchangeGithubCode,
  findOrCreateUserViaGithub,
  type GithubProfile,
  readStateCookie,
  resolveRedirectUri,
  signOauthState,
  verifyOauthState,
  verifyStateCookieMatches,
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

// `next` whitelist lives in `@agent-team-foundation/first-tree-hub-shared/safe-redirect`
// so the SPA's fragment consumer (`/auth/github/complete`) applies the
// same rule. Drift between the two = open-redirect or token-fixation
// risk; co-locating the regex prevents that.
const startQuerySchema = z.object({
  next: z
    .string()
    .optional()
    .transform((v) => sanitizeNextPath(v)),
  // Dev-stub overrides — ignored in production. The frontend doesn't normally
  // pass these; tests do, and a curl-based local dev workflow can.
  dev_login: z.string().optional(),
  dev_email: z.email().max(254).optional(),
  dev_id: z.string().optional(),
});

const callbackQuerySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

const devCallbackQuerySchema = z.object({
  state: z.string().min(1),
  login: z.string().min(1).max(64),
  /** Numeric-stringified GitHub id; tests use predictable values. */
  github_id: z.string().min(1).max(64),
  // Validated even on the dev stub — the value lands in `users.email` and
  // `auth_providers.email_at_link`, which surfaces in admin UIs.
  email: z.email().max(254).optional(),
  display_name: z.string().max(200).optional(),
  avatar_url: z.url().max(2048).optional(),
});

export async function authGithubRoutes(app: FastifyInstance): Promise<void> {
  const oauth = app.config.oauth?.github;

  // Half-configured OAuth is unsafe: a deployment that sets clientId but
  // forgets clientSecret would silently fall back to dev mode and accept
  // forged identities at /dev-callback. Refuse to register routes — fail
  // loud at boot so the operator notices immediately.
  if ((oauth?.clientId && !oauth?.clientSecret) || (!oauth?.clientId && oauth?.clientSecret)) {
    throw new Error(
      "GitHub OAuth half-configured: set BOTH FIRST_TREE_HUB_OAUTH_GITHUB_CLIENT_ID and FIRST_TREE_HUB_OAUTH_GITHUB_CLIENT_SECRET, or neither (dev mode).",
    );
  }
  const devMode = !oauth?.clientId || !oauth?.clientSecret;

  app.get("/start", async (request, reply) => {
    const query = startQuerySchema.parse(request.query);
    const { state, nonce } = await signOauthState(app.config.secrets.jwtSecret, query.next);
    const origin = readOrigin(request);
    // Bind the state to THIS browser via an HttpOnly cookie. /callback
    // requires the cookie to match the JWT's nonce — without this an
    // attacker who calls /start themselves can trick a victim into
    // signing in as the attacker (login-CSRF).
    reply.header("set-cookie", buildStateCookie(nonce, origin.proto === "https"));

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
    const { nonce, next } = await verifyOauthState(app.config.secrets.jwtSecret, query.state);
    // Login-CSRF gate. The cookie was set in /start and round-trips on the
    // top-level GitHub→callback navigation (SameSite=Lax). Mismatch =>
    // some other tab / actor started this state.
    verifyStateCookieMatches(nonce, readStateCookie(request.headers.cookie));
    const origin = readOrigin(request);
    const redirectUri = resolveRedirectUri(oauth?.redirectUri, origin);

    if (!oauth) {
      throw new UnauthorizedError("OAuth misconfigured");
    }
    const profile = await exchangeGithubCode(
      { clientId: oauth.clientId, clientSecret: oauth.clientSecret, redirectUri },
      query.code,
    );
    // One-shot cookie — clear after successful match so a replayed callback
    // can't reuse the same nonce.
    reply.header("set-cookie", clearStateCookie(origin.proto === "https"));
    return completeSignIn(app, reply, profile, next);
  });

  if (devMode) {
    app.get("/dev-callback", async (request, reply) => {
      const query = devCallbackQuerySchema.parse(request.query);
      // No cookie check here — `/dev-callback` is the dev-mode opt-out of
      // CSRF protection. Production deploys never register this route.
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
 * Resolve a GitHub profile to a user, then 302-redirect the browser to the
 * SPA's completion page with the tokens + `nextRoute` packed into the URL
 * fragment.
 *
 * Why a fragment and not a JSON body or query string:
 *   * JSON body: GitHub bounces the browser here via 302; a JSON response
 *     would render as raw text in the address bar.
 *   * Query string: tokens land in proxy / CDN / web-server access logs.
 *   * Fragment: never transmitted to the server, only the SPA sees it; the
 *     SPA immediately persists to localStorage and `replaceState`s the
 *     fragment out of the browser history. This is the standard "implicit
 *     grant" delivery shape for SPA-based OAuth on a Bearer-token API.
 *
 * The SPA route that consumes this fragment lives at
 * `/auth/github/complete` — see `packages/web/src/pages/auth-callback.tsx`.
 *
 * Failure modes (token sign / DB error) bubble up and the global error
 * handler turns them into a 500; the SPA's `/signup` page can detect via
 * `?error=` and re-prompt.
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

  const fragment = new URLSearchParams({
    access: tokens.accessToken,
    refresh: tokens.refreshToken,
    next: nextRoute,
  });
  return reply.redirect(`/auth/github/complete#${fragment.toString()}`, 302);
}

function readOrigin(request: FastifyRequest): { proto: string; host: string } {
  const proto = (request.headers["x-forwarded-proto"] as string | undefined) ?? request.protocol;
  const host =
    (request.headers["x-forwarded-host"] as string | undefined) ??
    (request.headers.host as string | undefined) ??
    request.hostname;
  return { proto, host };
}
