import type { DoneFuncWithErrOrRes, FastifyReply, FastifyRequest, onSendHookHandler } from "fastify";

/**
 * App-wide browser security headers (issue #1541 / SEC-041).
 *
 * The server is the only thing that ever answers browser requests in a
 * deployment (TLS terminates at the edge, but no edge layer sets headers —
 * there is no _headers / nginx / Caddy config in this repo), so the Fastify
 * layer owns the full response-header security surface:
 *
 *   - A fixed set of headers on EVERY response (API JSON, static assets,
 *     SPA HTML, 404 / error bodies, health checks).
 *   - A Content-Security-Policy on `text/html` responses only — the SPA
 *     shell served directly or via the SPA fallback, plus any other HTML
 *     the server may emit (e.g. an `inline` HTML attachment).
 *   - Strict-Transport-Security only when the request actually arrived over
 *     https (behind the TLS-terminating proxy this requires the existing
 *     FIRST_TREE_TRUST_PROXY=true so `request.protocol` reflects
 *     X-Forwarded-Proto; plain-HTTP local dev never sees the header).
 */
export type SecurityHeadersOptions = {
  /**
   * CSP delivery mode for HTML responses:
   *   - `report-only` (default): send the full policy as
   *     Content-Security-Policy-Report-Only plus a small zero-risk enforced
   *     subset. The spec ignores `frame-ancestors` in a report-only header,
   *     so the anti-embedding requirement can only ship enforced — that is
   *     why the two headers are split rather than sending RO alone.
   *   - `enforce`: send the full policy as Content-Security-Policy.
   *   - `off`: send no CSP header at all (emergency escape hatch; the
   *     unconditional headers below are unaffected).
   */
  cspMode: "report-only" | "enforce" | "off";
  /**
   * Extra `connect-src` origins appended to the built-in allowlist,
   * space- or comma-separated — e.g. a regional / self-hosted Sentry
   * ingest domain not covered by the defaults.
   */
  cspConnectSrcExtra?: string;
  /** CSP violation report endpoint (`report-uri` directive). */
  cspReportUri?: string;
  /** Send Strict-Transport-Security on https responses. */
  hstsEnabled: boolean;
};

/**
 * Zero-risk subset enforced while the full policy is still report-only:
 * nothing in the app is ever framed, uses plugins, or rewrites its base URL,
 * and `frame-ancestors` MUST be enforced to mean anything (see
 * `SecurityHeadersOptions.cspMode`).
 */
const REPORT_ONLY_ENFORCED_SUBSET = "frame-ancestors 'none'; object-src 'none'; base-uri 'self'";

/** One year, in seconds. No `includeSubDomains` / `preload`: the cloud host
 * has no subdomains to protect, while a self-hosted operator experimenting
 * with TLS on a shared parent domain would be locked out of plain-HTTP
 * siblings — the blast radius is not worth the zero marginal win. */
const HSTS_VALUE = "max-age=31536000";

/**
 * Build the full Content-Security-Policy string.
 *
 * Exported separately so tests can assert on the policy without booting an
 * app. The allowlist is evidence-driven (see issue #1541):
 *   - `script-src`: self (Vite emits only same-origin external scripts; the
 *     former inline bootstrap now lives in `/init.js`) + the GA4 / Clarity
 *     loader hosts. `https://*.clarity.ms` covers `www.clarity.ms`.
 *   - `style-src 'unsafe-inline'`: React `style={{…}}` attributes are used
 *     throughout the app (Radix / cmdk included); style attributes require
 *     it.
 *   - `img-src data: blob: https:`: chat images render as `data:` URLs,
 *     upload previews use `URL.createObjectURL`, human avatars and
 *     user-authored markdown reference arbitrary https images.
 *   - `connect-src`: same-origin API/WS (`'self'` matches same-host ws/wss
 *     per CSP3) + GA4 / Clarity collection + Sentry ingest domains, plus
 *     the operator-provided extras.
 *   - Everything is same-origin or denied otherwise; the app never frames
 *     other content and must never be framed (`frame-ancestors 'none'`).
 */
export function buildCsp(options: SecurityHeadersOptions): string {
  const connectSrc = [
    "'self'",
    "https://*.google-analytics.com",
    "https://*.analytics.google.com",
    "https://*.googletagmanager.com",
    "https://*.clarity.ms",
    "https://c.bing.com",
    "https://*.ingest.sentry.io",
    "https://*.ingest.us.sentry.io",
    ...normalizeSourceList(options.cspConnectSrcExtra),
  ];
  const directives = [
    "default-src 'self'",
    "script-src 'self' https://*.googletagmanager.com https://*.clarity.ms",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self'",
    `connect-src ${connectSrc.join(" ")}`,
    "manifest-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  const reportUri = normalizeReportUri(options.cspReportUri);
  if (reportUri) {
    directives.push(`report-uri ${reportUri}`);
  }
  return directives.join("; ");
}

/**
 * `true` when a response `content-type` header value is HTML. Exported for
 * unit tests. Handles the header being unset (e.g. a hijacked reply) and
 * uppercase spellings; a string[] value (multi-value header) never happens
 * for content-type, so it deliberately fails the check.
 */
export function isHtmlContentType(contentType: unknown): boolean {
  return typeof contentType === "string" && contentType.toLowerCase().startsWith("text/html");
}

/**
 * Global `onSend` hook applying the security headers described above.
 *
 * Must be registered before route registration (next to
 * `bodyCaptureOnSendHook` in `buildApp`) — Fastify routes snapshot the hook
 * chain at registration time, so only hooks added earlier cover the API
 * routes, the static handler and the SPA fallback.
 *
 * Overwrite semantics: existing same-named headers are overwritten
 * UNCONDITIONALLY. Today the only overlap is the attachment route's
 * identical `X-Content-Type-Options: nosniff` (idempotent); if a route ever
 * needs a differing value, switch this hook to set-if-absent explicitly
 * rather than relying on registration order.
 *
 * Deliberately a CALLBACK hook, not an async one: the body is pure
 * synchronous header writes, and every async onSend hook adds a microtask
 * gap between `reply.send()` and the response head being written. A handler
 * that calls `reply.send()` without returning the reply (fire-and-forget)
 * can then race the head write and die with ERR_HTTP_HEADERS_SENT — adding
 * a second async hook next to `bodyCaptureOnSendHook` reproducibly did so.
 * The callback form adds zero async gap.
 */
export function createSecurityHeadersOnSendHook(options: SecurityHeadersOptions): onSendHookHandler {
  // The header values are request-independent — compute them once.
  const csp = buildCsp(options);

  return function securityHeadersOnSendHook(
    request: FastifyRequest,
    reply: FastifyReply,
    payload: unknown,
    done: DoneFuncWithErrOrRes,
  ): void {
    reply.header("X-Content-Type-Options", "nosniff");
    // Matches the modern-browser default → zero behavior change, but makes
    // the guarantee explicit for sensitive paths like `/invite/:token`.
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    // Legacy-browser complement of `frame-ancestors 'none'`.
    reply.header("X-Frame-Options", "DENY");
    // Minimal deny-list: these device APIs are unused. `clipboard-write` is
    // deliberately NOT restricted (copy buttons use navigator.clipboard).
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");

    // `request.protocol` is only "https" when TLS terminated here (never in
    // this deployment) or when trustProxy makes X-Forwarded-Proto
    // authoritative — so a spoofed XFP header without trustProxy can not
    // conjure HSTS onto a plain-HTTP deployment.
    if (options.hstsEnabled && request.protocol === "https") {
      reply.header("Strict-Transport-Security", HSTS_VALUE);
    }

    if (options.cspMode !== "off" && isHtmlContentType(reply.getHeader("content-type"))) {
      if (options.cspMode === "enforce") {
        reply.header("Content-Security-Policy", csp);
      } else {
        reply.header("Content-Security-Policy", REPORT_ONLY_ENFORCED_SUBSET);
        reply.header("Content-Security-Policy-Report-Only", csp);
      }
    }

    done(null, payload);
  };
}

/**
 * Split an operator-provided source list on whitespace / commas, dropping
 * `;` and newlines first so a mis-quoted env value cannot smuggle extra CSP
 * directives into the policy.
 */
function normalizeSourceList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .replace(/[;\r\n]/g, " ")
    .split(/[\s,]+/)
    .filter((source) => source.length > 0);
}

/**
 * Trim the report URI and strip `;`, whitespace and newlines — same
 * directive-injection guard as `normalizeSourceList`. A URL containing any
 * of these was invalid for `report-uri` anyway.
 */
function normalizeReportUri(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(/[;\s]/g, "");
  return cleaned.length > 0 ? cleaned : undefined;
}
