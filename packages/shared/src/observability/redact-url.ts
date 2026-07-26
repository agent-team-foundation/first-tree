/**
 * Query-parameter keys whose VALUES are replaced with `***` whenever a URL is
 * logged or stamped onto a span attribute. Kept aligned with `LOG_REDACT_PATHS`
 * so structured-log redaction (object fields) and URL-string redaction (query
 * parameters) share the same vocabulary.
 *
 * Comparison is case-sensitive. Every JWT-bearing URL in this codebase uses
 * the lowercase `?token=…` form (browser WebSocket can't set Authorization
 * headers, hence the query-param fallback in admin WS), so we trade the
 * safety of case-insensitive matching for a tighter implementation.
 */
export const REDACT_QUERY_KEYS: ReadonlySet<string> = new Set([
  "token",
  "access_token",
  "accessToken",
  "refresh_token",
  "refreshToken",
  "jwt",
  "password",
  "secret",
  "api_key",
  "apiKey",
  "credentials",
  "authorization",
]);

const REDACTED = "***";

/**
 * Replace sensitive query-parameter values with `***` while preserving the
 * path, every other parameter, and the rest of the URL verbatim.
 *
 * Walks the query string by `&` then by the **first** `=`. Only the key is
 * matched against the redact set; the value is never inspected. So a literal
 * `?organizationId=019dfb...` is always preserved regardless of how the
 * value happens to look.
 */
export function redactUrl(url: string): string {
  const pathRedacted = url.replace(/(\/api\/v1\/webhooks\/gitlab\/)[^/?#]+/g, `$1${REDACTED}`);
  const qIdx = pathRedacted.indexOf("?");
  if (qIdx === -1) return pathRedacted;
  const path = pathRedacted.slice(0, qIdx);
  const query = pathRedacted.slice(qIdx + 1);
  if (query.length === 0) return pathRedacted;
  const redacted = query
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq === -1) return pair;
      const key = pair.slice(0, eq);
      return REDACT_QUERY_KEYS.has(key) ? `${key}=${REDACTED}` : pair;
    })
    .join("&");
  return `${path}?${redacted}`;
}
