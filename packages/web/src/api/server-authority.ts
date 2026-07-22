const AUTHORITY_ENDPOINT = "/api/v1/bootstrap/server-authority";
const EXPECTED_AUTHORITY_HEADER = "X-First-Tree-Expected-Authority";

let pinnedAuthority: string | null = null;
let pendingProbe: Promise<string> | null = null;

const MAX_AUTHORITY_RESPONSE_BYTES = 4096;
const MAX_AUTHORITY_LENGTH = 2048;
const AMBIGUOUS_AUTHORITY_HOSTS = new Set(["0.0.0.0", "[::]", "*"]);

export class ServerAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerAuthorityError";
  }
}

/** Normalize and validate the stable API authority returned by the server. */
export function canonicalizeServerAuthority(value: string): string {
  if (value.length === 0 || value.length > MAX_AUTHORITY_LENGTH) {
    throw new ServerAuthorityError("Server returned an invalid authority");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ServerAuthorityError("Server returned an invalid authority");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ServerAuthorityError("Server authority must use HTTP or HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ServerAuthorityError("Server authority contains forbidden URL components");
  }
  if (AMBIGUOUS_AUTHORITY_HOSTS.has(url.hostname.toLowerCase())) {
    throw new ServerAuthorityError("Server authority must identify one server");
  }
  if (url.pathname.replace(/\/+$/u, "") !== "/api/v1") {
    throw new ServerAuthorityError("Server authority must identify /api/v1");
  }
  url.pathname = "/api/v1";
  return url.toString().replace(/\/$/u, "");
}

function parseProbePayload(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ServerAuthorityError("Server authority response is malformed");
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "authority" ||
    keys[1] !== "v" ||
    !("v" in value) ||
    !("authority" in value) ||
    value.v !== 1 ||
    typeof value.authority !== "string" ||
    value.authority.length > 2048
  ) {
    throw new ServerAuthorityError("Server authority response is malformed");
  }
  return canonicalizeServerAuthority(value.authority);
}

/**
 * Read a response through a real byte cap rather than buffering an untrusted
 * body with `Response.text()` and checking only after allocation.
 */
export async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/u.test(contentLength) || Number(contentLength) > maxBytes)) {
    throw new ServerAuthorityError("Server response is oversized");
  }

  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let byteLength = 0;
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        throw new ServerAuthorityError("Server response is oversized");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof ServerAuthorityError) throw error;
    throw new ServerAuthorityError("Server response is malformed");
  }
}

async function fetchAuthority(): Promise<string> {
  const response = await fetch(AUTHORITY_ENDPOINT, {
    method: "GET",
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    redirect: "error",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new ServerAuthorityError("Server authority is unavailable");
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new ServerAuthorityError("Server authority response is malformed");
  }
  let body: string;
  try {
    body = await readBoundedResponseText(response, MAX_AUTHORITY_RESPONSE_BYTES);
  } catch {
    throw new ServerAuthorityError("Server authority response is malformed");
  }
  try {
    return parseProbePayload(JSON.parse(body) as unknown);
  } catch (error) {
    if (error instanceof ServerAuthorityError) throw error;
    throw new ServerAuthorityError("Server authority response is malformed");
  }
}

/**
 * Pin this document to the first verified server authority. A later Vite
 * retarget is a mismatch, never an implicit adoption of a different server.
 */
export async function getPinnedServerAuthority(): Promise<string> {
  if (pinnedAuthority) return pinnedAuthority;
  if (!pendingProbe) {
    pendingProbe = fetchAuthority().finally(() => {
      pendingProbe = null;
    });
  }
  const authority = await pendingProbe;
  if (pinnedAuthority && pinnedAuthority !== authority) {
    throw new ServerAuthorityError("Server authority changed");
  }
  pinnedAuthority = authority;
  return authority;
}

/** Re-probe without replacing the document's existing authority pin. */
export async function reconcilePinnedServerAuthority(expected: string): Promise<string> {
  const canonicalExpected = canonicalizeServerAuthority(expected);
  const observed = await fetchAuthority();
  if (observed !== canonicalExpected) throw new ServerAuthorityError("Server authority changed");
  if (pinnedAuthority && pinnedAuthority !== observed) throw new ServerAuthorityError("Server authority changed");
  pinnedAuthority = observed;
  return observed;
}

export function expectedAuthorityHeaders(authority: string): Record<string, string> {
  return { [EXPECTED_AUTHORITY_HEADER]: canonicalizeServerAuthority(authority) };
}

export { AUTHORITY_ENDPOINT, EXPECTED_AUTHORITY_HEADER };
