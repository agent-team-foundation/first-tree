const AUTHORITY_ENDPOINT = "/api/v1/bootstrap/server-authority";
const EXPECTED_AUTHORITY_HEADER = "X-First-Tree-Expected-Authority";

export type ServerAuthorityObservation = Readonly<{
  authority: string;
  viteGeneration: string | null;
}>;

let pinnedObservation: ServerAuthorityObservation | null = null;
let pendingProbe: Promise<ServerAuthorityObservation> | null = null;

const MAX_AUTHORITY_RESPONSE_BYTES = 4096;
const MAX_AUTHORITY_LENGTH = 2048;
const AMBIGUOUS_AUTHORITY_HOSTS = new Set(["0.0.0.0", "[::]", "*"]);
const VITE_GENERATION_PATTERN = /^[a-f0-9]{32}$/u;

export class ServerAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerAuthorityError";
  }
}

class ServerAuthorityUnavailableError extends ServerAuthorityError {}

type ServerAuthorityProbe =
  | Readonly<{ kind: "observed"; observation: ServerAuthorityObservation }>
  | Readonly<{ kind: "offline"; viteGeneration: string }>;

export type ServerAuthorityReconciliation =
  | Readonly<{ kind: "match"; authority: string }>
  | Readonly<{ kind: "mismatch"; expected: string; observed: string }>
  | Readonly<{ kind: "unavailable"; expected: string }>;

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
  const canonical = url.toString().replace(/\/$/u, "");
  if (new TextEncoder().encode(canonical).byteLength > MAX_AUTHORITY_LENGTH) {
    throw new ServerAuthorityError("Server returned an invalid authority");
  }
  return canonical;
}

function parseViteGeneration(value: unknown): string {
  if (typeof value !== "string" || !VITE_GENERATION_PATTERN.test(value)) {
    throw new ServerAuthorityError("Server authority response is malformed");
  }
  return value;
}

function parseProbePayload(value: unknown): ServerAuthorityObservation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ServerAuthorityError("Server authority response is malformed");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const isProductionPayload =
    keys.length === 2 && keys[0] === "authority" && keys[1] === "v" && !("viteGeneration" in record);
  const isVitePayload = keys.length === 3 && keys[0] === "authority" && keys[1] === "v" && keys[2] === "viteGeneration";
  if (
    (!isProductionPayload && !isVitePayload) ||
    record.v !== 1 ||
    typeof record.authority !== "string" ||
    record.authority.length > 2048
  ) {
    throw new ServerAuthorityError("Server authority response is malformed");
  }
  return Object.freeze({
    authority: canonicalizeServerAuthority(record.authority),
    viteGeneration: isVitePayload ? parseViteGeneration(record.viteGeneration) : null,
  });
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

function parseOfflineProbe(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "error" ||
    keys[1] !== "offlineEligible" ||
    keys[2] !== "viteGeneration" ||
    !("error" in value) ||
    !("offlineEligible" in value) ||
    !("viteGeneration" in value) ||
    value.error !== "server_authority_unavailable" ||
    value.offlineEligible !== true
  ) {
    return null;
  }
  try {
    return parseViteGeneration(value.viteGeneration);
  } catch {
    return null;
  }
}

async function fetchAuthority(): Promise<ServerAuthorityProbe> {
  let response: Response;
  try {
    response = await fetch(AUTHORITY_ENDPOINT, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      redirect: "error",
      headers: { Accept: "application/json" },
    });
  } catch {
    // A browser fetch rejection does not expose a trustworthy transport code.
    // TLS, redirect, CORS, parser, and application failures are therefore not
    // eligible for offline hot-cache recovery. Vite reports the narrow OS
    // failure allowlist through its bounded 503 response below.
    throw new ServerAuthorityError("Server authority probe failed closed");
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (response.status === 503) {
    if (contentType !== "application/json") {
      throw new ServerAuthorityError("Server authority response is malformed");
    }
    let body: string;
    try {
      body = await readBoundedResponseText(response, MAX_AUTHORITY_RESPONSE_BYTES);
    } catch {
      throw new ServerAuthorityError("Server authority response is malformed");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new ServerAuthorityError("Server authority response is malformed");
    }
    const viteGeneration = parseOfflineProbe(parsed);
    if (viteGeneration === null) {
      throw new ServerAuthorityError("Server authority probe failed closed");
    }
    return Object.freeze({ kind: "offline", viteGeneration });
  }
  if (!response.ok) throw new ServerAuthorityError("Server authority probe failed closed");
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
    return Object.freeze({ kind: "observed", observation: parseProbePayload(JSON.parse(body) as unknown) });
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
  if (pinnedObservation) return pinnedObservation.authority;
  if (!pendingProbe) {
    pendingProbe = fetchAuthority()
      .then((probe) => {
        if (probe.kind === "offline") throw new ServerAuthorityUnavailableError("Server authority is unavailable");
        return probe.observation;
      })
      .finally(() => {
        pendingProbe = null;
      });
  }
  const observation = await pendingProbe;
  const currentPin = pinnedObservation as ServerAuthorityObservation | null;
  if (
    currentPin &&
    (currentPin.authority !== observation.authority || currentPin.viteGeneration !== observation.viteGeneration)
  ) {
    throw new ServerAuthorityError("Server authority changed");
  }
  pinnedObservation = observation;
  return observation.authority;
}

/**
 * Return an immutable copy of the exact transport observation pinned by this
 * document. Full-page navigations cannot attach the expected-authority header,
 * so the Vite-only navigation builder uses this same observation to bind its
 * query proof to both the server and the current Vite process.
 */
export async function getPinnedServerTransportObservation(): Promise<ServerAuthorityObservation> {
  await getPinnedServerAuthority();
  const observation = pinnedObservation as ServerAuthorityObservation | null;
  if (!observation) {
    throw new ServerAuthorityError("Server authority is not pinned");
  }
  return Object.freeze({
    authority: observation.authority,
    viteGeneration: observation.viteGeneration,
  });
}

/**
 * Re-probe without replacing the document's existing authority pin. Offline
 * unavailability is distinct from a reachable, different server.
 */
export async function reconcilePinnedServerAuthority(expected: string): Promise<ServerAuthorityReconciliation> {
  const canonicalExpected = canonicalizeServerAuthority(expected);
  if (pinnedObservation !== null && pinnedObservation.authority !== canonicalExpected) {
    return Object.freeze({ kind: "mismatch", expected: canonicalExpected, observed: pinnedObservation.authority });
  }
  const probe = await fetchAuthority();
  if (probe.kind === "offline") {
    if (
      pinnedObservation?.authority !== canonicalExpected ||
      pinnedObservation.viteGeneration === null ||
      pinnedObservation.viteGeneration !== probe.viteGeneration
    ) {
      throw new ServerAuthorityError("Offline recovery requires a verified document authority");
    }
    return Object.freeze({ kind: "unavailable", expected: canonicalExpected });
  }
  const observed = probe.observation;
  const pinnedExpected = pinnedObservation?.authority ?? canonicalExpected;
  if (
    observed.authority !== canonicalExpected ||
    (pinnedObservation !== null && pinnedObservation.authority !== observed.authority)
  ) {
    return Object.freeze({ kind: "mismatch", expected: pinnedExpected, observed: observed.authority });
  }
  if (pinnedObservation !== null && pinnedObservation.viteGeneration !== observed.viteGeneration) {
    throw new ServerAuthorityError("Server authority process changed");
  }
  pinnedObservation = observed;
  return Object.freeze({ kind: "match", authority: observed.authority });
}

export function expectedAuthorityHeaders(authority: string): Record<string, string> {
  return { [EXPECTED_AUTHORITY_HEADER]: canonicalizeServerAuthority(authority) };
}

export { AUTHORITY_ENDPOINT, EXPECTED_AUTHORITY_HEADER };
