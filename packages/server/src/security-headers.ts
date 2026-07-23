import type { FastifyInstance } from "fastify";
import type { Config } from "./config.js";

/**
 * App-wide browser security headers (issue #1541).
 *
 * Every HTTP response this server produces — SPA shell, static assets,
 * API JSON, 404s, and error bodies — carries the same header set, so the
 * security guarantee is code-owned and testable in every environment
 * instead of living invisibly in edge/CDN configuration.
 *
 * Shape is code-owned here; only the third-party origin allowlists come
 * from `config.security` (see `shared/src/config/server-config.ts`).
 * Keyword sources are deliberately NOT configurable so a deployment env
 * var can never introduce `'unsafe-inline'` / `'unsafe-eval'` into script
 * directives.
 *
 * Directive rationale:
 * - `default-src 'self'` — least-privilege fallback for every fetch
 *   directive not listed explicitly (fonts, manifests, media, workers,
 *   frames all collapse to same-origin).
 * - `script-src` — `'self'` plus configured analytics loaders only. The
 *   web bundle contains no inline scripts (the former `index.html`
 *   bootstraps live in `/theme-init.js` and `/analytics-init.js`), so no
 *   nonce/hash machinery is needed.
 * - `style-src 'unsafe-inline'` — React `style={}` attributes and
 *   library-injected inline styles are widespread and benign; the issue
 *   scope only forbids unsafe-inline in *script* directives.
 * - `img-src data: blob:` — canvas avatar crops and pre-upload image
 *   previews use object/data URLs; remote images are limited to the
 *   configured avatar/analytics hosts, so arbitrary remote images in chat
 *   markdown are intentionally blocked.
 * - `connect-src 'self'` covers the same-origin API; the same-origin
 *   WebSocket origin is derived from `server.publicUrl` and added
 *   explicitly for browsers that predate CSP3's scheme-upgrade matching.
 * - `frame-ancestors 'none'` + `X-Frame-Options: DENY` — the product has
 *   no embedding use case; the authenticated dashboard must not be
 *   frameable.
 * - `object-src 'none'`, `base-uri 'self'`, `form-action 'self'` — close
 *   the classic plugin/base-hijack/form-exfiltration injection routes.
 */

/** One year, in seconds — the issue's minimum HSTS lifetime. */
const HSTS_MAX_AGE_SECONDS = 31_536_000;

/**
 * Derive the same-origin WebSocket source from the deployment's public URL.
 * Returns `undefined` when no public URL is configured (dev quickstart) —
 * `connect-src 'self'` already matches same-origin `ws(s):` in CSP3-era
 * browsers, so the explicit entry is a compatibility widening, not the
 * primary grant.
 */
function websocketSelfSource(publicUrl: string | undefined): string | undefined {
  if (!publicUrl) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(publicUrl);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  const scheme = parsed.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${parsed.host}`;
}

function directive(name: string, sources: (string | undefined)[]): string {
  const filtered = sources.filter((source): source is string => Boolean(source));
  return `${name} ${filtered.join(" ")}`;
}

/** Build the enforced Content-Security-Policy value for this deployment. */
export function buildContentSecurityPolicy(config: Config): string {
  const { cspScriptOrigins, cspConnectOrigins, cspImgOrigins } = config.security;
  return [
    directive("default-src", ["'self'"]),
    directive("base-uri", ["'self'"]),
    directive("object-src", ["'none'"]),
    directive("frame-ancestors", ["'none'"]),
    directive("form-action", ["'self'"]),
    directive("script-src", ["'self'", ...cspScriptOrigins]),
    directive("style-src", ["'self'", "'unsafe-inline'"]),
    directive("img-src", ["'self'", "data:", "blob:", ...cspImgOrigins]),
    directive("font-src", ["'self'"]),
    directive("connect-src", ["'self'", websocketSelfSource(config.server.publicUrl), ...cspConnectOrigins]),
  ].join("; ");
}

/**
 * The complete header set applied to every response. Computed once at app
 * build time — the values are pure functions of static config.
 */
export function buildSecurityHeaders(config: Config): Record<string, string> {
  return {
    "content-security-policy": buildContentSecurityPolicy(config),
    // Ignored by browsers over plain http (per RFC 6797), so it is safe to
    // send unconditionally — local plain-http development is unaffected.
    "strict-transport-security": `max-age=${HSTS_MAX_AGE_SECONDS}; includeSubDomains`,
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
    // Redundant with `frame-ancestors 'none'` for CSP-aware browsers; kept
    // per issue scope as the legacy-browser belt to CSP's suspenders.
    "x-frame-options": "DENY",
  };
}

/**
 * Register the app-wide header layer. `onSend` (rather than `onRequest`)
 * guarantees coverage of every reply path Fastify can produce: routed
 * handlers, the SPA not-found fallback, plugin-thrown 4xx (rate limit),
 * and the error handler.
 */
export function registerSecurityHeaders(app: FastifyInstance, config: Config): void {
  if (!config.security.headersEnabled) {
    app.log.warn("app-wide security headers are DISABLED via config (FIRST_TREE_SECURITY_HEADERS_ENABLED)");
    return;
  }
  const headers = buildSecurityHeaders(config);
  app.addHook("onSend", (_request, reply, payload, done) => {
    reply.headers(headers);
    done(null, payload);
  });
}
