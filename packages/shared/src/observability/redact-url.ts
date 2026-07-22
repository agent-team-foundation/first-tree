/**
 * Canonical, lowercase URL-context keys whose values must never reach logs or
 * trace attributes. This list is deliberately independent of structured-field
 * redaction: ordinary application fields such as `{ code: "no_installation" }`
 * are useful and are not URL capabilities.
 */
export const REDACT_QUERY_KEYS: ReadonlySet<string> = new Set([
  "token",
  "access_token",
  "accesstoken",
  "refresh_token",
  "refreshtoken",
  "jwt",
  "password",
  "secret",
  "api_key",
  "apikey",
  "credentials",
  "authorization",
  "code",
  "state",
  "ticket",
  "claim",
]);

const REDACTED = "***";

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (character) => String.fromCharCode(character.charCodeAt(0) + 32));
}

type RedactedComponent = { ok: true; value: string } | { ok: false };

/**
 * Redact one form-style query or fragment component without normalizing its
 * original spelling, order, or duplicates. Keys are decoded exactly once
 * using form semantics. Malformed key encoding fails closed for the entire
 * component because a downstream parser may still accept an alias that a
 * best-effort logger would otherwise miss.
 */
function redactComponent(component: string): RedactedComponent {
  if (component.length === 0) return { ok: true, value: component };
  const output: string[] = [];
  for (const pair of component.split("&")) {
    const equalsIndex = pair.indexOf("=");
    const rawKey = equalsIndex === -1 ? pair : pair.slice(0, equalsIndex);
    let decodedKey: string;
    try {
      decodedKey = decodeURIComponent(rawKey.replace(/\+/g, " "));
    } catch {
      return { ok: false };
    }
    if (REDACT_QUERY_KEYS.has(asciiLower(decodedKey))) {
      output.push(`${rawKey}=${REDACTED}`);
    } else {
      output.push(pair);
    }
  }
  return { ok: true, value: output.join("&") };
}

/**
 * Replace sensitive query and form-style fragment values while preserving
 * every safe byte. GitLab's path capability is scrubbed first. This helper is
 * total for every JavaScript string and never constructs URL/URLSearchParams,
 * so duplicate occurrences and malformed raw targets cannot be collapsed or
 * reinterpreted before redaction.
 */
export function redactUrl(url: string): string {
  const pathRedacted = url.replace(/(\/api\/v1\/webhooks\/gitlab\/)[^/?#]+/g, `$1${REDACTED}`);
  const fragmentIndex = pathRedacted.indexOf("#");
  const beforeFragment = fragmentIndex === -1 ? pathRedacted : pathRedacted.slice(0, fragmentIndex);
  const fragment = fragmentIndex === -1 ? null : pathRedacted.slice(fragmentIndex + 1);
  const queryIndex = beforeFragment.indexOf("?");
  const path = queryIndex === -1 ? beforeFragment : beforeFragment.slice(0, queryIndex);
  const query = queryIndex === -1 ? null : beforeFragment.slice(queryIndex + 1);

  let result = path;
  if (query !== null) {
    const redactedQuery = redactComponent(query);
    result += `?${redactedQuery.ok ? redactedQuery.value : REDACTED}`;
  }
  if (fragment !== null) {
    const redactedFragment = redactComponent(fragment);
    result += `#${redactedFragment.ok ? redactedFragment.value : REDACTED}`;
  }
  return result;
}
