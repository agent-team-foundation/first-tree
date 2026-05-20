/**
 * Minimal HTTP driver for the e2e suite. The point of this helper is to keep
 * the per-test `fetch(`${baseUrl}${path}`, { headers: { Authorization: ... }
 * })` plumbing in one place — NOT to build a business-verb client. The driver
 * does:
 *
 *   - join `serverBaseUrl` + `path`,
 *   - inject `Authorization: Bearer <token>` and `Content-Type: application/json`
 *     when a body is given,
 *   - JSON-encode the body when provided,
 *
 * and nothing else. No retries, no status-code branching, no envelope
 * unwrap. Tests still call this with the exact HTTP method + path the real
 * caller would use, and read `Response.status` + `Response.json()` themselves
 * — that way the test is exercising the same wire contract a real client
 * would hit. See `packages/e2e/README.md` for the "protocol adapters, not
 * business clients" rule this helper exists to enforce.
 */

/** Body shape accepted by the global `fetch` — defined inline so we don't
 * depend on `BodyInit` (not exposed by `@types/node` today). */
type FetchBody = NonNullable<Parameters<typeof fetch>[1]>["body"];

export type AuthedFetchOptions = {
  /** Override the default `application/json` content type for non-JSON bodies. */
  contentType?: string;
  /** Pass a pre-encoded body (Buffer / string / form) — caller owns serialization. */
  rawBody?: FetchBody;
  /** Extra headers to merge in. Authorization is always set from `accessToken`. */
  headers?: Record<string, string>;
};

export async function authedFetch(
  serverBaseUrl: string,
  accessToken: string,
  method: string,
  path: string,
  body?: unknown,
  opts: AuthedFetchOptions = {},
): Promise<Response> {
  const url = `${serverBaseUrl}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    ...(opts.headers ?? {}),
  };
  let requestBody: FetchBody | undefined;
  if (opts.rawBody !== undefined) {
    requestBody = opts.rawBody;
    if (opts.contentType) headers["Content-Type"] = opts.contentType;
  } else if (body !== undefined) {
    requestBody = JSON.stringify(body);
    headers["Content-Type"] = opts.contentType ?? "application/json";
  }
  return fetch(url, { method, headers, body: requestBody });
}

/**
 * Convenience: `authedFetch` + JSON-decode + 201/200 assertion. Use for the
 * common case where the test wants to assert success and continue with the
 * decoded payload; reach for `authedFetch` directly when the test needs to
 * branch on status codes.
 */
export async function authedJson<T = unknown>(
  serverBaseUrl: string,
  accessToken: string,
  method: string,
  path: string,
  body?: unknown,
  expectStatus: number | number[] = [200, 201],
): Promise<T> {
  const res = await authedFetch(serverBaseUrl, accessToken, method, path, body);
  const expected = Array.isArray(expectStatus) ? expectStatus : [expectStatus];
  if (!expected.includes(res.status)) {
    const text = await res.text().catch(() => "<no body>");
    throw new Error(`${method} ${path} expected ${expected.join("/")}, got ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}
