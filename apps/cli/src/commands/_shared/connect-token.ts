/**
 * Helpers for connect-token decoding.
 *
 * Shared by `login` (top-level) and any future caller (e.g. `status` may want
 * to inspect a pasted token without running the full login flow). Lives in
 * `_shared/` so `apps/cli/src/index.ts` can re-export the URL-derivation helper
 * without coupling the public-API surface to a specific command file.
 */

type ConnectJwt = {
  iss?: unknown;
  /** Owning user id. Present on access/refresh/connect tokens alike. */
  sub?: unknown;
  memberId?: unknown;
  organizationId?: unknown;
};

const SHORT_CONNECT_CODE_PATTERN = /^[A-Za-z0-9_-]{20,}$/;

/**
 * @internal
 * Decode a JWT payload without verifying its signature. Used only by the
 * CLI's account-switch prompt and the URL-derivation helper below. Not
 * re-exported from `apps/cli/src/index.ts` — external consumers should call
 * `deriveHubUrlFromToken` instead.
 */
export function decodeJwtPayload(token: string): ConnectJwt | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1]) return null;
    const raw = Buffer.from(parts[1], "base64url").toString();
    const obj = JSON.parse(raw) as unknown;
    if (typeof obj !== "object" || obj === null) return null;
    return obj as ConnectJwt;
  } catch {
    return null;
  }
}

export class HubUrlDerivationError extends Error {
  constructor(
    public readonly code: "INVALID_TOKEN" | "TOKEN_MISSING_ISS" | "TOKEN_BAD_ISS" | "TOKEN_BAD_URL",
    message: string,
  ) {
    super(message);
    this.name = "HubUrlDerivationError";
  }
}

function normalizeHubUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new HubUrlDerivationError("TOKEN_BAD_ISS", `Connect token server URL "${url}" is not an http(s) URL.`);
    }
    return parsed.origin;
  } catch (err) {
    if (err instanceof HubUrlDerivationError) throw err;
    throw new HubUrlDerivationError("TOKEN_BAD_ISS", `Connect token server URL "${url}" is not an http(s) URL.`);
  }
}

export function isShortConnectCode(token: string): boolean {
  return SHORT_CONNECT_CODE_PATTERN.test(token);
}

/**
 * Derive the server URL from a connect token. New connect tokens are short
 * codes whose server URL comes from the current CLI channel (or an explicit
 * caller fallback). Legacy JWT connect tokens still carry the server URL
 * themselves. Throws `HubUrlDerivationError` when no safe routing source is
 * available.
 *
 * The action handler maps the thrown error to a `fail()` exit so this
 * function stays unit-testable without spawning a subprocess.
 */
export function deriveHubUrlFromToken(token: string, fallbackUrl?: string): string {
  const trimmed = token.trim();
  try {
    const url = new URL(trimmed);
    if (url.protocol) {
      throw new HubUrlDerivationError(
        "TOKEN_BAD_URL",
        "Connect code must be the short code only, not a URL. Generate a fresh code from the First Tree web console.",
      );
    }
  } catch (err) {
    if (err instanceof HubUrlDerivationError) throw err;
  }

  const payload = decodeJwtPayload(trimmed);
  if (!payload) {
    if (fallbackUrl && isShortConnectCode(trimmed)) {
      return normalizeHubUrl(fallbackUrl);
    }
    const expected = fallbackUrl ? "short code or JWT" : "JWT";
    throw new HubUrlDerivationError(
      "INVALID_TOKEN",
      `Connect token is not a valid ${expected}. Generate a new one from the First Tree web console.`,
    );
  }
  const iss = payload.iss;
  if (typeof iss !== "string" || iss.length === 0) {
    throw new HubUrlDerivationError(
      "TOKEN_MISSING_ISS",
      "Connect token does not carry an issuer (`iss` claim). Generate a new token from a First Tree server running v0.10+.",
    );
  }
  return normalizeHubUrl(iss);
}
