import { createHash } from "node:crypto";

export const SERVER_AUTHORITY_PATH = "/api/v1";
export const SERVER_AUTHORITY_MAX_LENGTH = 2048;
export const EXPECTED_SERVER_AUTHORITY_HEADER = "x-first-tree-expected-authority";
export const AVATAR_AUTHORITY_QUERY_KEY = "ft_authority";
export const AVATAR_AUTHORITY_TAG_LENGTH = 43;

const AVATAR_AUTHORITY_DOMAIN = "first-tree-avatar-authority-v1\0";
const AVATAR_AUTHORITY_TAG_RE = /^[A-Za-z0-9_-]{43}$/;
const AMBIGUOUS_AUTHORITY_HOSTS = new Set(["0.0.0.0", "[::]", "*"]);

function isAmbiguousAuthorityHostname(hostname: string): boolean {
  return AMBIGUOUS_AUTHORITY_HOSTS.has(hostname.toLowerCase());
}

export type ServerAuthorityConfig = Readonly<{
  authority?: string;
  publicUrl?: string;
  host: string;
  port: number;
}>;

/**
 * Canonicalize a stable API authority. Request Host and forwarded headers
 * must never be passed here: the result is persisted namespace material.
 */
export function canonicalizeServerAuthority(value: string): string {
  if (value.length === 0 || value.length > SERVER_AUTHORITY_MAX_LENGTH) {
    throw new Error(`Server authority must be between 1 and ${SERVER_AUTHORITY_MAX_LENGTH} characters`);
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Server authority must be an absolute HTTP(S) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Server authority must use HTTP or HTTPS");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Server authority must not contain credentials");
  }
  if (isAmbiguousAuthorityHostname(parsed.hostname)) {
    throw new Error("Server authority must identify one server, not a wildcard bind host");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("Server authority must not contain a query string or fragment");
  }

  const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  if (pathname !== SERVER_AUTHORITY_PATH) {
    throw new Error(`Server authority path must be exactly ${SERVER_AUTHORITY_PATH}`);
  }
  return `${parsed.origin}${SERVER_AUTHORITY_PATH}`;
}

/** Derive the fixed API authority from a configured public server origin. */
export function serverAuthorityFromPublicUrl(publicUrl: string): string {
  if (publicUrl.length === 0 || publicUrl.length > SERVER_AUTHORITY_MAX_LENGTH) {
    throw new Error(`Public server URL must be between 1 and ${SERVER_AUTHORITY_MAX_LENGTH} characters`);
  }

  let parsed: URL;
  try {
    parsed = new URL(publicUrl);
  } catch {
    throw new Error("Public server URL must be an absolute HTTP(S) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Public server URL must use HTTP or HTTPS");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Public server URL must not contain credentials");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("Public server URL must not contain a query string or fragment");
  }
  if (parsed.pathname.replace(/\/+$/, "") !== "") {
    throw new Error("Public server URL must be an origin without a path");
  }
  return canonicalizeServerAuthority(`${parsed.origin}${SERVER_AUTHORITY_PATH}`);
}

/** Resolve explicit, public-URL-derived, or unambiguous local authority. */
export function resolveServerAuthority(config: ServerAuthorityConfig): string {
  const explicit = config.authority ? canonicalizeServerAuthority(config.authority) : undefined;
  // Validate the callback origin even when a separate stable authority is
  // explicit. Both values are security configuration; neither may be silently
  // ignored because the other one is present.
  const fromPublicUrl = config.publicUrl ? serverAuthorityFromPublicUrl(config.publicUrl) : undefined;
  // An explicit authority is the stable namespace identity. It is allowed to
  // differ from FIRST_TREE_PUBLIC_URL: local OAuth commonly returns through a
  // rotating public tunnel while the server identity remains stable. Public
  // URL still owns callback construction; it is not an identity alias.
  if (explicit) return explicit;
  if (fromPublicUrl) return fromPublicUrl;

  const host = config.host.trim();
  if (!host) {
    throw new Error(
      "FIRST_TREE_SERVER_AUTHORITY is required when FIRST_TREE_PUBLIC_URL is unset and FIRST_TREE_HOST is wildcard or ambiguous",
    );
  }
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
    throw new Error("FIRST_TREE_PORT must be an integer between 0 and 65535");
  }
  const authorityHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const candidate = `http://${authorityHost}:${config.port}${SERVER_AUTHORITY_PATH}`;
  try {
    if (isAmbiguousAuthorityHostname(new URL(candidate).hostname)) {
      throw new Error(
        "FIRST_TREE_SERVER_AUTHORITY is required when FIRST_TREE_PUBLIC_URL is unset and FIRST_TREE_HOST is wildcard or ambiguous",
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("FIRST_TREE_SERVER_AUTHORITY")) throw error;
    // canonicalizeServerAuthority below supplies the stable public error for
    // every other malformed host shape.
  }
  return canonicalizeServerAuthority(candidate);
}

export function deriveAvatarAuthorityTag(authority: string): string {
  const canonical = canonicalizeServerAuthority(authority);
  return createHash("sha256").update(`${AVATAR_AUTHORITY_DOMAIN}${canonical}`, "utf8").digest("base64url");
}

export function isAvatarAuthorityTag(value: string): boolean {
  return AVATAR_AUTHORITY_TAG_RE.test(value);
}
