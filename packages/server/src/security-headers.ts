import type { FastifyInstance } from "fastify";
import type { Config } from "./config.js";

/**
 * App-wide browser security headers (issue #1541).
 *
 * The server serves both the API and the SPA, so the header layer lives here
 * rather than in edge configuration: every environment gets the same testable
 * guarantee. `buildSecurityHeaders` is the single place where header values
 * are composed (pure, unit-testable); `registerSecurityHeaders` installs them
 * as a root-level `onSend` hook — the same precedent as
 * `bodyCaptureOnSendHook` in app.ts — so API routes, `@fastify/static` sends,
 * the SPA fallback, and error responses are all covered by one hook.
 *
 * The CSP is enforced (not Report-Only) and least-privilege: `index.html`
 * ships zero inline scripts (see packages/web/public/), so `script-src` needs
 * no `unsafe-inline`/`unsafe-eval`. Environment-specific origins are
 * config-driven via the `security` group in server-config.ts.
 */

/**
 * Built-in `img-src` avatar origins: the OAuth profile picture hosts our login
 * providers return (`users.avatar_url` from GitHub, `picture` from Google).
 * Replaced wholesale by FIRST_TREE_CSP_AVATAR_ORIGINS when configured.
 */
const DEFAULT_AVATAR_ORIGINS = ["https://avatars.githubusercontent.com", "https://lh3.googleusercontent.com"];

/** Header name → env var that feeds it, for boot-time error messages. */
const ENV_NAMES = {
  analytics: "FIRST_TREE_CSP_ANALYTICS_ORIGINS",
  avatar: "FIRST_TREE_CSP_AVATAR_ORIGINS",
  extraConnect: "FIRST_TREE_CSP_EXTRA_CONNECT_SRC",
} as const;

/**
 * Parse a space- or comma-separated origin list into deduped origins. Each
 * entry must be an exact http(s) origin (scheme + host, no path/query/trailing
 * slash) so the emitted CSP stays predictable. Invalid entries throw — the
 * call site runs at boot, so a typo fails startup loudly instead of silently
 * weakening the policy.
 */
function parseOriginList(raw: string, envName: string): string[] {
  const tokens = raw.split(/[\s,]+/).filter((token) => token.length > 0);
  for (const token of tokens) {
    let url: URL;
    try {
      url = new URL(token);
    } catch {
      throw new Error(`${envName}: "${token}" is not a valid URL (expected an origin like https://example.com)`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error(`${envName}: "${token}" must use http or https`);
    }
    if (url.origin !== token) {
      throw new Error(
        `${envName}: "${token}" must be a bare origin (got path/query/trailing slash — e.g. ${url.origin})`,
      );
    }
  }
  return [...new Set(tokens)];
}

/** Compose the full security header set from config. Pure — safe to unit-test. */
export function buildSecurityHeaders(config: Config): Record<string, string> {
  const security = config.security;
  const analyticsOrigins = security?.cspAnalyticsOrigins
    ? parseOriginList(security.cspAnalyticsOrigins, ENV_NAMES.analytics)
    : [];
  const avatarOrigins = security?.cspAvatarOrigins
    ? parseOriginList(security.cspAvatarOrigins, ENV_NAMES.avatar)
    : DEFAULT_AVATAR_ORIGINS;
  const extraConnectOrigins = security?.cspExtraConnectSrcOrigins
    ? parseOriginList(security.cspExtraConnectSrcOrigins, ENV_NAMES.extraConnect)
    : [];

  const scriptSrc = ["'self'", ...analyticsOrigins];
  // 'self' covers the same-origin WebSocket (CSP3 matches ws/wss on the same
  // host). Analytics origins collect beacons; extra connect origins cover
  // environment services such as Sentry ingest or object storage.
  const connectSrc = ["'self'", ...analyticsOrigins, ...extraConnectOrigins];
  // data: — markdown / inline SVG images; blob: — URL.createObjectURL previews
  // (avatar crop, pending image attachments).
  const imgSrc = ["'self'", "data:", "blob:", ...avatarOrigins, ...analyticsOrigins];

  const contentSecurityPolicy = [
    "default-src 'self'",
    `script-src ${[...new Set(scriptSrc)].join(" ")}`,
    // React/Radix write style attributes at runtime; script directives stay
    // free of unsafe-inline/unsafe-eval as required.
    "style-src 'self' 'unsafe-inline'",
    `img-src ${[...new Set(imgSrc)].join(" ")}`,
    `connect-src ${[...new Set(connectSrc)].join(" ")}`,
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");

  return {
    "content-security-policy": contentSecurityPolicy,
    "strict-transport-security": "max-age=31536000; includeSubDomains",
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "x-frame-options": "DENY",
  };
}

/**
 * Install the security headers on the root instance. Header values are
 * computed once at boot (config is frozen); an invalid CSP origin therefore
 * fails startup loudly. Must be called before routes are registered so the
 * hook propagates to API scopes, static sends, the SPA fallback, and error
 * responses alike.
 *
 * The hook is deliberately SYNCHRONOUS (callback style). An extra async
 * onSend hook delays the chain by one microtask, which trips a latent fastify
 * footgun: async handlers that call `reply.send()` bare (without returning
 * the reply) get re-sent by fastify's wrap-thenable fallback when the
 * response hasn't ended yet — `settings.ts`'s DELETE 204 double-writes
 * headers that way. Keeping this hook sync preserves the exact onSend timing
 * the app had before it existed.
 */
export function registerSecurityHeaders(app: FastifyInstance, config: Config): void {
  const headers = buildSecurityHeaders(config);
  app.addHook("onSend", (_request, reply, _payload, done) => {
    for (const [name, value] of Object.entries(headers)) {
      // General rule: a route's own value always wins over the app-wide
      // default (route-level escape hatch). In practice the only route
      // setting any of these today is attachment downloads, which have set
      // X-Content-Type-Options: nosniff — the same value — since before this
      // hook existed.
      if (reply.hasHeader(name)) continue;
      reply.header(name, value);
    }
    done();
  });
}
