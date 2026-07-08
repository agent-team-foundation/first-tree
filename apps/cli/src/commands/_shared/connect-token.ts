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

/**
 * Derive the server URL from a connect token. New connect tokens are short
 * URLs (`https://hub/connect/<code>`) whose origin is the server URL. Legacy
 * JWT connect tokens still carry the server URL in their `iss` claim. Throws
 * `HubUrlDerivationError` when the claim is missing or malformed — we
 * *never* fall back to a default URL because that would let a stale connect
 * token from one environment silently re-target another (prod → staging
 * foot-gun).
 *
 * The action handler maps the thrown error to a `fail()` exit so this
 * function stays unit-testable without spawning a subprocess.
 */
export function deriveHubUrlFromToken(token: string): string {
  try {
    const url = new URL(token);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new HubUrlDerivationError(
        "TOKEN_BAD_URL",
        "Connect token URL must use http(s). Generate a new token from the First Tree web console.",
      );
    }
    if (!/^\/connect\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) {
      throw new HubUrlDerivationError(
        "TOKEN_BAD_URL",
        "Connect token URL must look like https://<server>/connect/<code>. Generate a new token from the First Tree web console.",
      );
    }
    return url.origin;
  } catch (err) {
    if (err instanceof HubUrlDerivationError) throw err;
  }

  const payload = decodeJwtPayload(token);
  if (!payload) {
    throw new HubUrlDerivationError(
      "INVALID_TOKEN",
      "Connect token is not a valid connect URL or JWT. Generate a new one from the First Tree web console.",
    );
  }
  const iss = payload.iss;
  if (typeof iss !== "string" || iss.length === 0) {
    throw new HubUrlDerivationError(
      "TOKEN_MISSING_ISS",
      "Connect token does not carry an issuer (`iss` claim). Generate a new token from a First Tree server running v0.10+.",
    );
  }
  if (!/^https?:\/\//i.test(iss)) {
    throw new HubUrlDerivationError(
      "TOKEN_BAD_ISS",
      `Connect token issuer "${iss}" is not an http(s) URL. Generate a new token.`,
    );
  }
  return iss.replace(/\/+$/, "");
}
