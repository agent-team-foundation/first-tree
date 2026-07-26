import { z } from "zod";

export const AUTH_PROVIDERS = ["google", "github"] as const;
export const authProviderSchema = z.enum(AUTH_PROVIDERS);
export type AuthProvider = z.infer<typeof authProviderSchema>;

export const authProviderAvailabilitySchema = z.object({
  google: z.boolean(),
  github: z.boolean(),
});
export type AuthProviderAvailability = z.infer<typeof authProviderAvailabilitySchema>;

export const OAUTH_INTENTS = ["sign-in", "link", "unlink"] as const;
export const oauthIntentSchema = z.enum(OAUTH_INTENTS);
export type OAuthIntent = z.infer<typeof oauthIntentSchema>;

export const oauthStartQuerySchema = z.object({
  next: z.string().max(256).optional(),
});
export type OAuthStartQuery = z.infer<typeof oauthStartQuerySchema>;

export const googleCallbackQuerySchema = z
  .object({
    code: z.string().min(1).optional(),
    state: z.string().min(1).optional(),
    error: z.string().min(1).optional(),
  })
  .refine(({ code, state, error }) => Boolean(error || (code && state)), {
    message: "Google callback must include an error or both code and state",
  });
export type GoogleCallbackQuery = z.infer<typeof googleCallbackQuerySchema>;

export const authProviderConnectionSchema = z.object({
  provider: authProviderSchema,
  available: z.boolean(),
  connected: z.boolean(),
  accountName: z.string().nullable(),
  email: z.string().email().nullable(),
  avatarUrl: z.string().url().nullable(),
  connectedAt: z.string().datetime().nullable(),
  canUnlink: z.boolean(),
  unlinkBlockedReason: z.enum(["last-provider"]).nullable(),
});
export type AuthProviderConnection = z.infer<typeof authProviderConnectionSchema>;

export const authProviderConnectionsResponseSchema = z.object({
  providers: z.array(authProviderConnectionSchema),
});
export type AuthProviderConnectionsResponse = z.infer<typeof authProviderConnectionsResponseSchema>;

export const authProviderActionResultSchema = z.object({
  redirectUrl: z.string().min(1),
});
export type AuthProviderActionResult = z.infer<typeof authProviderActionResultSchema>;

export const authProviderParamsSchema = z.object({ provider: authProviderSchema });

export const OAUTH_ERROR_CODES = [
  "state-expired",
  "provider-not-configured",
  "provider-exchange-failed",
  "identity-conflict",
  "identity-mismatch",
  "last-provider",
  "membership-unresolved",
  "invite-invalid",
  "invite-not-allowed",
  "invite-required",
] as const;
export const oauthErrorCodeSchema = z.enum(OAUTH_ERROR_CODES);
export type OAuthErrorCode = z.infer<typeof oauthErrorCodeSchema>;

/**
 * `GET /api/v1/auth/github/start` query — `next` is the post-login landing
 * path. It is validated again before signing the state JWT (see
 * `safe-redirect.ts`); the schema only enforces the syntactic upper bound
 * so over-long paths bounce with a Zod error rather than silently truncate.
 */
export const githubStartQuerySchema = oauthStartQuerySchema;
export type GithubStartQuery = z.infer<typeof githubStartQuerySchema>;

export const githubCallbackQuerySchema = z.object({
  /**
   * OAuth authorization code. Optional because GitHub's *setup* redirects
   * land here without one: `setup_action=request` (install awaiting owner
   * approval, observed on staging with no `code`) and post-approval /
   * post-configure landings from GitHub's own settings UI. The route
   * handles code-less shapes as navigation-only landings — no sign-in, no
   * session change.
   */
  code: z.string().min(1).optional(),
  /**
   * Signed First Tree state JWT. Optional because setup redirects that
   * originate on GitHub's side (an owner approving/configuring the App
   * from GitHub's settings UI) carry no state — those used to explode as
   * a raw Zod error page. The route redirects stateless landings to the
   * SPA instead.
   */
  state: z.string().min(1).optional(),
  /**
   * Provider-side cancellation / denial. GitHub returns this instead of a
   * code when the user closes or rejects the authorization prompt. Keep the
   * raw value bounded at the schema edge; the route collapses every value to
   * one fixed, low-cardinality failure reason before it reaches analytics.
   */
  error: z.string().min(1).max(128).optional(),
  /**
   * GitHub App installation ID. Present when the user landed in callback
   * via the install flow ("first install of the App by this user / org").
   * Returning users who already had the App installed get `code` + `state`
   * without `installation_id` — First Tree must tolerate both shapes.
   *
   * Numeric per GitHub but transported as a query-string field, so accept
   * a digit-only string and coerce in the route handler.
   */
  installation_id: z.string().regex(/^\d+$/).optional(),
  /**
   * GitHub may send `setup_action=install` (first-time install), `update`
   * (existing install reconfigured / re-visited), or `request` (the user
   * requested install but an org admin must approve). We don't branch on
   * it — `code`/`state` presence is the actual signal — but we accept all
   * three shapes so otherwise-valid callbacks aren't rejected at the
   * schema gate (codex P2 follow-up).
   */
  setup_action: z.enum(["install", "update", "request"]).optional(),
});
export type GithubCallbackQuery = z.infer<typeof githubCallbackQuerySchema>;

/**
 * Dev-only callback to bypass the GitHub round-trip — sign in as a stub
 * Github user. Gated by NODE_ENV !== 'production'; production always 404s.
 *
 * The App-flow extension fields (`installationId`, `installationAccountType`,
 * `installationAccountLogin`, `installationAccountGithubId`) let the dev
 * flow simulate a GitHub App install in the same redirect — when present
 * they stub a `github_app_installations` row before the OAuth flow
 * completes, so the rest of the dev session can exercise the App-bound
 * code paths (Settings → Integrations panel, webhook routing) without a
 * real install. Missing → legacy OAuth-only dev flow.
 */
export const githubDevCallbackQuerySchema = z.object({
  /** Synthetic GitHub numeric id (acts as `auth_identities.identifier`). */
  githubId: z.string().min(1),
  /** GitHub login slug — used for the default org slug derivation. */
  login: z.string().min(1),
  email: z.string().email().optional(),
  displayName: z.string().optional(),
  next: z.string().max(256).optional(),
  /** Synthetic installation id. Required to trigger the App-flow dev bypass. */
  installationId: z.string().regex(/^\d+$/).optional(),
  /** "User" | "Organization". Defaults to "User" when an installationId is set. */
  installationAccountType: z.enum(["User", "Organization"]).optional(),
  /** Account login for the simulated install. Defaults to `login`. */
  installationAccountLogin: z.string().min(1).optional(),
  /** Account numeric id for the simulated install. Defaults to `githubId`. */
  installationAccountGithubId: z.string().regex(/^\d+$/).optional(),
});
export type GithubDevCallbackQuery = z.infer<typeof githubDevCallbackQuerySchema>;
