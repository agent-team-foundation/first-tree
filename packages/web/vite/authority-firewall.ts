import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest, type IncomingMessage, type ServerResponse, STATUS_CODES } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";
import {
  AVATAR_AUTHORITY_QUERY_KEY,
  canonicalizeServerAuthority,
  deriveAvatarAuthorityTag,
  EXPECTED_SERVER_AUTHORITY_HEADER,
  SERVER_AUTHORITY_MAX_LENGTH,
  SERVER_AUTHORITY_PATH as SERVER_AUTHORITY_SUFFIX,
} from "@first-tree/shared/config";
import type { Plugin, ViteDevServer } from "vite";

export const SERVER_AUTHORITY_PATH = "/api/v1/bootstrap/server-authority";
export const EXPECTED_AUTHORITY_HEADER = EXPECTED_SERVER_AUTHORITY_HEADER;
export const AVATAR_AUTHORITY_QUERY = AVATAR_AUTHORITY_QUERY_KEY;
export const API_PROXY_CONTEXT = "^/api/v1(?:/|$|\\?)";
export const VITE_GENERATION_PATTERN = /^[a-f0-9]{32}$/u;
export const VITE_NAVIGATION_PROOF_QUERY = "ft_vite_nav";

const PROBE_BODY_MAX_BYTES = SERVER_AUTHORITY_MAX_LENGTH + 128;
const PROBE_TIMEOUT_MS = 2_000;
const UPGRADE_TIMEOUT_MS = 5_000;
const RAW_TARGET_MAX_BYTES = 2_048;
const PROTECTED_NAVIGATION_TARGET_MAX_BYTES = 8_192;
const BASE64URL_AUTHORITY_MAX_LENGTH = Math.ceil((SERVER_AUTHORITY_MAX_LENGTH * 4) / 3);
const ENCODED_AUTHORITY_MAX_BYTES = SERVER_AUTHORITY_MAX_LENGTH * 3;
const ADMIN_WS_RAW_TARGET_MAX_BYTES = ENCODED_AUTHORITY_MAX_BYTES + 256;
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OFFLINE_ELIGIBLE_TRANSPORT_CODES = new Set(["EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT"]);
const TRANSPORT_ERROR_CAUSE_MAX_DEPTH = 4;
const AVATAR_TARGET_PATTERN =
  /^\/api\/v1\/agents\/([a-z0-9_-]{1,100})\/avatar\?v=(0|[1-9][0-9]{0,15})&ft_authority=([A-Za-z0-9_-]{43})$/;
const ADMIN_WS_TARGET_PATTERN = new RegExp(
  `^/api/v1/orgs/([a-z0-9_-]{1,100})/ws/\\?ft_authority=([^&]{1,${ENCODED_AUTHORITY_MAX_BYTES}})$`,
);
const VITE_NAVIGATION_PROOF_PATTERN = new RegExp(
  `^v1\\.([a-f0-9]{32})\\.([A-Za-z0-9_-]{1,${BASE64URL_AUTHORITY_MAX_LENGTH}})$`,
);
const SAFE_NAVIGATION_QUERY_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;
const PROTECTED_NAVIGATION_QUERY_KEYS = new Map<string, ReadonlySet<string>>([
  ["/api/v1/auth/github/start", new Set(["next"])],
  ["/api/v1/auth/google/start", new Set(["next"])],
  [
    "/api/v1/auth/github/dev-callback",
    new Set([
      "githubId",
      "login",
      "email",
      "displayName",
      "next",
      "installationId",
      "installationAccountType",
      "installationAccountLogin",
      "installationAccountGithubId",
    ]),
  ],
]);

type ProbeFailureReason = "transport" | "redirect" | "status" | "content-type" | "oversized" | "malformed";

type ProbeResult =
  | { ok: true; authority: string }
  | { ok: false; offlineEligible: boolean; reason: ProbeFailureReason };

type AuthorityFirewallOptions = {
  target: string;
  probeTimeoutMs?: number;
  probeBodyMaxBytes?: number;
  upgradeTimeoutMs?: number;
};

type ParsedAvatarTarget = {
  upstreamTarget: string;
  authorityTag: string;
};

type ParsedAdminWsTarget = {
  upstreamTarget: string;
  expectedAuthority: string;
};

type ParsedProtectedNavigationTarget = Readonly<{
  expectedAuthority: string;
  upstreamTarget: string;
}>;

type ProtectedNavigationTarget =
  | Readonly<{ kind: "not-protected" }>
  | Readonly<{ kind: "invalid" }>
  | Readonly<{ kind: "valid"; target: ParsedProtectedNavigationTarget }>;

type AuthorityErrorBody = Readonly<{
  error: string;
  offlineEligible: boolean;
  viteGeneration?: string;
}>;

function readErrorProperty(error: object, property: "cause" | "code"): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: Reflect.get(error, property) };
  } catch {
    return { ok: false };
  }
}

/**
 * Classify only the OS failures for which a previously verified Vite target
 * may be treated as temporarily offline. Fetch wraps these in a TypeError, so
 * inspect a short cause chain without consulting attacker-influenced messages.
 * Any explicit but unknown code, accessor failure, cycle, or excessive depth
 * fails closed.
 */
export function isOfflineEligibleAuthorityTransportError(error: unknown): boolean {
  const visited = new Set<object>();
  let current = error;
  for (let depth = 0; depth < TRANSPORT_ERROR_CAUSE_MAX_DEPTH; depth += 1) {
    if ((typeof current !== "object" || current === null) && typeof current !== "function") return false;
    if (visited.has(current)) return false;
    visited.add(current);

    const codeResult = readErrorProperty(current, "code");
    if (!codeResult.ok) return false;
    if (codeResult.value !== undefined) {
      return typeof codeResult.value === "string" && OFFLINE_ELIGIBLE_TRANSPORT_CODES.has(codeResult.value);
    }
    const causeResult = readErrorProperty(current, "cause");
    if (!causeResult.ok) return false;
    current = causeResult.value;
  }
  return false;
}

/**
 * Canonical server identity used by the browser storage namespace and by the
 * Vite credential firewall. The Server produces this value from trusted
 * configuration, never from Host / X-Forwarded-* request headers.
 */
export function parseCanonicalServerAuthority(value: string): string | null {
  if (Buffer.byteLength(value, "utf8") === 0 || Buffer.byteLength(value, "utf8") > SERVER_AUTHORITY_MAX_LENGTH) {
    return null;
  }
  let canonical: string;
  try {
    canonical = canonicalizeServerAuthority(value);
  } catch {
    return null;
  }
  if (!canonical.endsWith(SERVER_AUTHORITY_SUFFIX)) return null;
  return value === canonical ? canonical : null;
}

/** Validate VITE_PROXY_TARGET as an origin, before any browser traffic exists. */
export function normalizeViteProxyTarget(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("VITE_PROXY_TARGET must be an absolute HTTP(S) origin");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("VITE_PROXY_TARGET must use HTTP or HTTPS");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("VITE_PROXY_TARGET must not contain credentials, query, or fragment");
  }
  if (parsed.pathname !== "/") {
    throw new Error("VITE_PROXY_TARGET must not contain a path");
  }
  return parsed.origin;
}

export function avatarAuthorityTag(authority: string): string {
  const canonical = parseCanonicalServerAuthority(authority);
  if (!canonical) throw new Error("Cannot tag a non-canonical server authority");
  return deriveAvatarAuthorityTag(canonical);
}

function isApiTarget(rawTarget: string): boolean {
  return rawTarget === "/api/v1" || rawTarget.startsWith("/api/v1/") || rawTarget.startsWith("/api/v1?");
}

function hasRequestBodyFraming(request: IncomingMessage): boolean {
  return (
    rawHeaderValues(request, "content-length").length > 0 || rawHeaderValues(request, "transfer-encoding").length > 0
  );
}

function parseAvatarTarget(method: string | undefined, rawTarget: string): ParsedAvatarTarget | null {
  if (method !== "GET" || Buffer.byteLength(rawTarget, "utf8") > RAW_TARGET_MAX_BYTES) return null;
  const match = AVATAR_TARGET_PATTERN.exec(rawTarget);
  if (!match) return null;
  const agentId = match[1];
  const version = match[2];
  const authorityTag = match[3];
  if (!agentId || !version || !authorityTag) return null;
  return {
    upstreamTarget: `/api/v1/agents/${agentId}/avatar?v=${version}&${AVATAR_AUTHORITY_QUERY}=${authorityTag}`,
    authorityTag,
  };
}

function parseAdminWsTarget(rawTarget: string): ParsedAdminWsTarget | null {
  if (Buffer.byteLength(rawTarget, "utf8") > ADMIN_WS_RAW_TARGET_MAX_BYTES) return null;
  const match = ADMIN_WS_TARGET_PATTERN.exec(rawTarget);
  if (!match) return null;
  const organizationId = match[1];
  const rawAuthority = match[2];
  if (!organizationId || !rawAuthority) return null;
  let authority: string;
  try {
    authority = decodeURIComponent(rawAuthority);
  } catch {
    return null;
  }
  if (encodeURIComponent(authority) !== rawAuthority) return null;
  const canonical = parseCanonicalServerAuthority(authority);
  if (!canonical) return null;
  return {
    upstreamTarget: `/api/v1/orgs/${organizationId}/ws/`,
    expectedAuthority: canonical,
  };
}

function classifyProtectedNavigationPath(rawPath: string): string | "invalid" | null {
  if (PROTECTED_NAVIGATION_QUERY_KEYS.has(rawPath)) return rawPath;
  if (!rawPath.includes("%")) return null;
  try {
    const decoded = decodeURIComponent(rawPath);
    return PROTECTED_NAVIGATION_QUERY_KEYS.has(decoded) ? "invalid" : null;
  } catch {
    return rawPath.startsWith("/api/v1/auth/") ? "invalid" : null;
  }
}

function decodeNavigationProof(rawProof: string, viteGeneration: string): string | null {
  const match = VITE_NAVIGATION_PROOF_PATTERN.exec(rawProof);
  if (!match || match[1] !== viteGeneration) return null;
  const encodedAuthority = match[2];
  if (!encodedAuthority) return null;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(encodedAuthority, "base64url");
  } catch {
    return null;
  }
  if (bytes.length === 0 || bytes.toString("base64url") !== encodedAuthority) return null;
  let authority: string;
  try {
    authority = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  return parseCanonicalServerAuthority(authority);
}

/**
 * Parse the only API routes that a browser must enter through a full-page GET.
 * Their proof is Vite-local transport binding, not application authority.
 * Unknown, duplicated, encoded, or reordered query shapes fail closed.
 */
function parseProtectedNavigationTarget(
  method: string | undefined,
  rawTarget: string,
  viteGeneration: string,
): ProtectedNavigationTarget {
  const queryIndex = rawTarget.indexOf("?");
  const rawPath = queryIndex < 0 ? rawTarget : rawTarget.slice(0, queryIndex);
  const classifiedPath = classifyProtectedNavigationPath(rawPath);
  if (classifiedPath === null) return { kind: "not-protected" };
  if (
    classifiedPath === "invalid" ||
    method !== "GET" ||
    queryIndex < 0 ||
    Buffer.byteLength(rawTarget, "utf8") > PROTECTED_NAVIGATION_TARGET_MAX_BYTES ||
    rawTarget.includes("#")
  ) {
    return { kind: "invalid" };
  }

  const allowedKeys = PROTECTED_NAVIGATION_QUERY_KEYS.get(classifiedPath);
  if (!allowedKeys) return { kind: "invalid" };
  const fields = rawTarget.slice(queryIndex + 1).split("&");
  if (fields.length === 0 || fields.some((field) => field.length === 0)) return { kind: "invalid" };
  const seen = new Set<string>();
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index] ?? "";
    const equals = field.indexOf("=");
    const key = equals < 0 ? field : field.slice(0, equals);
    const isProof = key === VITE_NAVIGATION_PROOF_QUERY;
    if (
      !SAFE_NAVIGATION_QUERY_KEY_PATTERN.test(key) ||
      seen.has(key) ||
      (!isProof && !allowedKeys.has(key)) ||
      (isProof && (index !== fields.length - 1 || equals < 0))
    ) {
      return { kind: "invalid" };
    }
    seen.add(key);
  }
  if (!seen.has(VITE_NAVIGATION_PROOF_QUERY)) return { kind: "invalid" };
  const proofField = fields.at(-1) ?? "";
  const proofEquals = proofField.indexOf("=");
  const expectedAuthority = decodeNavigationProof(proofField.slice(proofEquals + 1), viteGeneration);
  if (!expectedAuthority) return { kind: "invalid" };
  const businessFields = fields.slice(0, -1);
  return {
    kind: "valid",
    target: Object.freeze({
      expectedAuthority,
      upstreamTarget: businessFields.length > 0 ? `${classifiedPath}?${businessFields.join("&")}` : classifiedPath,
    }),
  };
}

function rawHeaderValues(request: IncomingMessage, name: string): string[] {
  const expected = name.toLowerCase();
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const key = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];
    if (key?.toLowerCase() === expected && value !== undefined) values.push(value);
  }
  return values;
}

function readExpectedAuthority(request: IncomingMessage): string | null {
  const values = rawHeaderValues(request, EXPECTED_AUTHORITY_HEADER);
  if (values.length !== 1) return null;
  return parseCanonicalServerAuthority(values[0] ?? "");
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function probeServerAuthority(target: string, timeoutMs: number, bodyMaxBytes: number): Promise<ProbeResult> {
  const controller = new AbortController();
  // A unique reason distinguishes our bounded probe timeout from unrelated
  // AbortError / TimeoutError failures raised by fetch or application code.
  const timeoutReason = new DOMException("server authority probe timed out", "TimeoutError");
  const timeout = setTimeout(() => controller.abort(timeoutReason), timeoutMs);
  try {
    const response = await fetch(`${target}${SERVER_AUTHORITY_PATH}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-store",
        Pragma: "no-cache",
      },
      cache: "no-store",
      credentials: "omit",
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      response.body?.cancel().catch(() => undefined);
      return { ok: false, offlineEligible: false, reason: "redirect" };
    }
    if (response.status !== 200) {
      response.body?.cancel().catch(() => undefined);
      return { ok: false, offlineEligible: false, reason: "status" };
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      response.body?.cancel().catch(() => undefined);
      return { ok: false, offlineEligible: false, reason: "content-type" };
    }
    const bytes = await readBoundedBody(response, bodyMaxBytes);
    if (!bytes) return { ok: false, offlineEligible: false, reason: "oversized" };
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return { ok: false, offlineEligible: false, reason: "malformed" };
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { ok: false, offlineEligible: false, reason: "malformed" };
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.length !== 2 || keys[0] !== "authority" || keys[1] !== "v" || record.v !== 1) {
      return { ok: false, offlineEligible: false, reason: "malformed" };
    }
    if (typeof record.authority !== "string") {
      return { ok: false, offlineEligible: false, reason: "malformed" };
    }
    const authority = parseCanonicalServerAuthority(record.authority);
    if (!authority) return { ok: false, offlineEligible: false, reason: "malformed" };
    return { ok: true, authority };
  } catch (error) {
    return {
      ok: false,
      offlineEligible: error === timeoutReason || isOfflineEligibleAuthorityTransportError(error),
      reason: "transport",
    };
  } finally {
    clearTimeout(timeout);
  }
}

function sanitizeAvatarRequest(request: IncomingMessage, upstreamTarget: string): void {
  // Vite's host-check middleware still runs after this pre-middleware. Keep
  // only the browser Host long enough for that local check; `changeOrigin`
  // replaces it with the configured target before the upstream request.
  const allowed = new Set(["host", "accept", "if-none-match", "if-modified-since"]);
  for (const key of Object.keys(request.headers)) {
    if (!allowed.has(key)) delete request.headers[key];
  }
  request.url = upstreamTarget;
}

function sanitizeProtectedNavigationRequest(request: IncomingMessage, upstreamTarget: string): void {
  // A top-level same-origin navigation automatically carries ambient cookies
  // and may carry cached HTTP auth. These anonymous acquisition routes need
  // neither. Rebuild an intentionally tiny request before the generic proxy.
  const allowed = new Set(["host", "accept", "accept-language", "user-agent"]);
  for (const key of Object.keys(request.headers)) {
    if (!allowed.has(key)) delete request.headers[key];
  }
  request.url = upstreamTarget;
}

function endHttpJson(
  request: IncomingMessage,
  response: ServerResponse,
  status: 421 | 503,
  body: AuthorityErrorBody,
): void {
  request.resume();
  const payload = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(payload));
  response.end(payload);
}

function synthesizeAuthorityResponse(response: ServerResponse, authority: string, viteGeneration: string): void {
  const payload = JSON.stringify({ v: 1, authority, viteGeneration });
  response.statusCode = 200;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(payload));
  response.end(payload);
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function endUpgradeJson(socket: Duplex, status: 421 | 503, body: AuthorityErrorBody): void {
  if (socket.destroyed) return;
  const payload = JSON.stringify(body);
  const reason = STATUS_CODES[status] ?? "Error";
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\n` +
      "Connection: close\r\n" +
      "Cache-Control: no-store\r\n" +
      "Content-Type: application/json; charset=utf-8\r\n" +
      `Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`,
  );
}

function websocketKey(request: IncomingMessage): string | null {
  const values = rawHeaderValues(request, "sec-websocket-key");
  if (values.length !== 1) return null;
  const key = values[0] ?? "";
  if (!/^[A-Za-z0-9+/]{22}==$/.test(key)) return null;
  try {
    return Buffer.from(key, "base64").byteLength === 16 ? key : null;
  } catch {
    return null;
  }
}

function websocketVersion(request: IncomingMessage): boolean {
  const values = rawHeaderValues(request, "sec-websocket-version");
  return values.length === 1 && values[0] === "13";
}

function websocketAccept(key: string): string {
  return createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
}

function forwardAdminUpgrade(args: {
  request: IncomingMessage;
  clientSocket: Duplex;
  target: string;
  upstreamTarget: string;
  timeoutMs: number;
  viteGeneration: string;
}): void {
  const { request, clientSocket, target, upstreamTarget, timeoutMs, viteGeneration } = args;
  const key = websocketKey(request);
  if (!key || !websocketVersion(request)) {
    endUpgradeJson(clientSocket, 421, { error: "server_authority_mismatch", offlineEligible: false });
    return;
  }
  const targetUrl = new URL(target);
  const requestUpgrade = targetUrl.protocol === "https:" ? httpsRequest : httpRequest;
  const upstreamRequest = requestUpgrade({
    protocol: targetUrl.protocol,
    hostname: targetUrl.hostname,
    port: targetUrl.port || undefined,
    method: "GET",
    path: upstreamTarget,
    headers: {
      Connection: "Upgrade",
      Upgrade: "websocket",
      "Sec-WebSocket-Key": key,
      "Sec-WebSocket-Version": "13",
    },
  });
  const timeoutReason = new Error("admin websocket upgrade timed out");
  const timeout = setTimeout(() => upstreamRequest.destroy(timeoutReason), timeoutMs);
  let settled = false;
  const fail = (offlineEligible: boolean): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    endUpgradeJson(clientSocket, 503, {
      error: "server_authority_unavailable",
      offlineEligible,
      viteGeneration,
    });
  };
  upstreamRequest.once("error", (error) => {
    fail(error === timeoutReason || isOfflineEligibleAuthorityTransportError(error));
  });
  upstreamRequest.once("response", (response) => {
    response.resume();
    fail(false);
  });
  upstreamRequest.once("upgrade", (response, upstreamSocket, upstreamHead) => {
    if (settled) {
      upstreamSocket.destroy();
      return;
    }
    settled = true;
    clearTimeout(timeout);
    const accept = response.headers["sec-websocket-accept"];
    if (typeof accept !== "string" || accept !== websocketAccept(key)) {
      upstreamSocket.destroy();
      endUpgradeJson(clientSocket, 503, {
        error: "server_authority_unavailable",
        offlineEligible: false,
        viteGeneration,
      });
      return;
    }
    clientSocket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    if (upstreamHead.length > 0) clientSocket.write(upstreamHead);
    upstreamSocket.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstreamSocket.destroy());
    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);
    clientSocket.resume();
  });
  upstreamRequest.end();
}

function logRejected(server: ViteDevServer, transport: "http" | "ws", reason: string): void {
  server.config.logger.warn(`first-tree authority firewall rejected ${transport} request (${reason})`);
}

/**
 * Vite-only firewall. It runs before the generic HTTP proxy and owns API
 * WebSocket upgrades so a stale browser cannot send S1 credentials, paths, or
 * request bytes after the developer retargets the same Vite origin to S2.
 */
export function firstTreeAuthorityFirewall(options: AuthorityFirewallOptions): Plugin {
  const target = normalizeViteProxyTarget(options.target);
  const viteGeneration = randomBytes(16).toString("hex");
  if (!VITE_GENERATION_PATTERN.test(viteGeneration)) {
    throw new Error("Vite authority generation could not be created");
  }
  const probeTimeoutMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  const probeBodyMaxBytes = options.probeBodyMaxBytes ?? PROBE_BODY_MAX_BYTES;
  const upgradeTimeoutMs = options.upgradeTimeoutMs ?? UPGRADE_TIMEOUT_MS;
  assertPositiveInteger(probeTimeoutMs, "probeTimeoutMs");
  assertPositiveInteger(probeBodyMaxBytes, "probeBodyMaxBytes");
  assertPositiveInteger(upgradeTimeoutMs, "upgradeTimeoutMs");

  return {
    name: "first-tree:authority-firewall",
    apply: "serve",
    enforce: "pre",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const rawTarget = request.url ?? "";
        if (!isApiTarget(rawTarget)) {
          next();
          return;
        }

        // Keep the business stream paused until the token-free authority
        // probe has passed. On rejection `endHttpJson` drains it locally; on
        // admission the downstream proxy's pipe resumes it exactly once.
        request.pause();

        const protectedNavigation = parseProtectedNavigationTarget(request.method, rawTarget, viteGeneration);
        if (protectedNavigation.kind === "invalid") {
          logRejected(server, "http", "missing-or-malformed-navigation-proof");
          endHttpJson(request, response, 421, { error: "server_authority_mismatch", offlineEligible: false });
          return;
        }
        const avatar = parseAvatarTarget(request.method, rawTarget);
        const isAuthorityRead = request.method === "GET" && rawTarget === SERVER_AUTHORITY_PATH;
        const expectedAuthority =
          protectedNavigation.kind === "valid"
            ? null
            : avatar
              ? null
              : isAuthorityRead
                ? null
                : readExpectedAuthority(request);
        if (protectedNavigation.kind === "valid" && hasRequestBodyFraming(request)) {
          logRejected(server, "http", "navigation-body");
          endHttpJson(request, response, 421, { error: "server_authority_mismatch", offlineEligible: false });
          return;
        }
        if (avatar && hasRequestBodyFraming(request)) {
          logRejected(server, "http", "avatar-body");
          endHttpJson(request, response, 421, { error: "server_authority_mismatch", offlineEligible: false });
          return;
        }
        if (protectedNavigation.kind !== "valid" && !avatar && !isAuthorityRead && !expectedAuthority) {
          logRejected(server, "http", "missing-or-malformed-proof");
          endHttpJson(request, response, 421, { error: "server_authority_mismatch", offlineEligible: false });
          return;
        }

        const probe = await probeServerAuthority(target, probeTimeoutMs, probeBodyMaxBytes);
        if (!probe.ok) {
          logRejected(server, "http", probe.reason);
          endHttpJson(request, response, 503, {
            error: "server_authority_unavailable",
            offlineEligible: probe.offlineEligible,
            viteGeneration,
          });
          return;
        }
        if (isAuthorityRead) {
          request.resume();
          synthesizeAuthorityResponse(response, probe.authority, viteGeneration);
          return;
        }
        if (avatar) {
          if (avatarAuthorityTag(probe.authority) !== avatar.authorityTag) {
            logRejected(server, "http", "avatar-tag-mismatch");
            endHttpJson(request, response, 421, { error: "server_authority_mismatch", offlineEligible: false });
            return;
          }
          sanitizeAvatarRequest(request, avatar.upstreamTarget);
          next();
          return;
        }
        if (protectedNavigation.kind === "valid") {
          if (protectedNavigation.target.expectedAuthority !== probe.authority) {
            logRejected(server, "http", "navigation-authority-mismatch");
            endHttpJson(request, response, 421, { error: "server_authority_mismatch", offlineEligible: false });
            return;
          }
          sanitizeProtectedNavigationRequest(request, protectedNavigation.target.upstreamTarget);
          next();
          return;
        }
        if (expectedAuthority !== probe.authority) {
          logRejected(server, "http", "authority-mismatch");
          endHttpJson(request, response, 421, { error: "server_authority_mismatch", offlineEligible: false });
          return;
        }
        next();
      });

      const httpServer = server.httpServer;
      if (!httpServer) return;
      const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
        const rawTarget = request.url ?? "";
        if (!isApiTarget(rawTarget)) return;
        socket.pause();
        if (head.length > 0) {
          logRejected(server, "ws", "early-data");
          endUpgradeJson(socket, 421, { error: "server_authority_mismatch", offlineEligible: false });
          return;
        }
        const parsed = parseAdminWsTarget(rawTarget);
        if (!parsed) {
          logRejected(server, "ws", "missing-or-malformed-proof");
          endUpgradeJson(socket, 421, { error: "server_authority_mismatch", offlineEligible: false });
          return;
        }
        void probeServerAuthority(target, probeTimeoutMs, probeBodyMaxBytes).then((probe) => {
          if (socket.destroyed) return;
          if (!probe.ok) {
            logRejected(server, "ws", probe.reason);
            endUpgradeJson(socket, 503, {
              error: "server_authority_unavailable",
              offlineEligible: probe.offlineEligible,
              viteGeneration,
            });
            return;
          }
          if (probe.authority !== parsed.expectedAuthority) {
            logRejected(server, "ws", "authority-mismatch");
            endUpgradeJson(socket, 421, { error: "server_authority_mismatch", offlineEligible: false });
            return;
          }
          forwardAdminUpgrade({
            request,
            clientSocket: socket,
            target,
            upstreamTarget: parsed.upstreamTarget,
            timeoutMs: upgradeTimeoutMs,
            viteGeneration,
          });
        });
      };
      httpServer.on("upgrade", handleUpgrade);
      httpServer.once("close", () => httpServer.off("upgrade", handleUpgrade));
    },
  };
}
