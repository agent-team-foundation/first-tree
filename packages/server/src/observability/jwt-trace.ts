import { decodeJwt } from "jose";

/**
 * Stable failure-reason buckets emitted onto trace spans when a JWT verify
 * call throws. Mapped from jose's distinct `err.code` values so dashboards
 * can `group by auth.*.reason` instead of grepping `exception.message`.
 *
 * Add new buckets here (not at call sites) so all three JWT verify paths
 * — `userAuthHook` access tokens, `refreshAccessToken`, `exchangeConnectToken`
 * — agree on the vocabulary.
 */
export type JwtFailureReason = "jwt_expired" | "jwt_signature_invalid" | "jwt_malformed" | "jwt_verify_failed";

/**
 * Map a thrown jose error to a stable failure-reason bucket. Unknown shapes
 * fall through to `jwt_verify_failed` so the span attribute always has a
 * value (callers can then refine the mapping without coordinating a deploy
 * with the trace backend).
 */
export function classifyJoseError(err: unknown): JwtFailureReason {
  if (typeof err !== "object" || err === null) return "jwt_verify_failed";
  const code = (err as { code?: unknown }).code;
  if (typeof code !== "string") return "jwt_verify_failed";
  switch (code) {
    case "ERR_JWT_EXPIRED":
      return "jwt_expired";
    case "ERR_JWS_SIGNATURE_VERIFICATION_FAILED":
      return "jwt_signature_invalid";
    case "ERR_JWT_INVALID":
    case "ERR_JWS_INVALID":
    case "ERR_JWT_CLAIM_VALIDATION_FAILED":
      return "jwt_malformed";
    default:
      return "jwt_verify_failed";
  }
}

/**
 * Decoded JWT claims surfaced onto a trace span when verification fails.
 *
 * **Trace-only — never used for authorization.** The signature is invalid,
 * expired, or otherwise untrusted by definition (the caller already failed
 * `jwtVerify`); these claims exist solely so an operator can pivot a 401 or
 * 429 trace by `sub` / `jti` to find the originating user/install. Anything
 * authorization-relevant must come from a fresh DB lookup keyed on a
 * separately-verified identity.
 */
export type UntrustedJwtClaims = {
  sub?: string;
  exp?: number;
  iat?: number;
  jti?: string;
  type?: string;
};

/**
 * Best-effort decode of a JWT *without* signature verification, for the sole
 * purpose of stamping its `sub` / `jti` / `exp` onto a failure trace.
 *
 * Returns `null` when the token is malformed enough that even base64 decode
 * fails — callers should treat absence as "no untrusted claims to record"
 * and continue without trace decoration.
 *
 * **Do not call from any code path that grants access.**
 */
export function decodeJwtForTrace(token: string): UntrustedJwtClaims | null {
  try {
    const claims = decodeJwt(token) as Record<string, unknown>;
    const out: UntrustedJwtClaims = {};
    if (typeof claims.sub === "string") out.sub = claims.sub;
    if (typeof claims.exp === "number") out.exp = claims.exp;
    if (typeof claims.iat === "number") out.iat = claims.iat;
    if (typeof claims.jti === "string") out.jti = claims.jti;
    if (typeof claims.type === "string") out.type = claims.type;
    return out;
  } catch {
    return null;
  }
}

/**
 * Spread-helper that turns untrusted claims into the `<prefix>.untrusted.*`
 * attribute keys used on auth failure spans. Keeps the call sites short:
 *
 *   throw new UnauthorizedError("...", {
 *     "auth.refresh.reason": reason,
 *     ...untrustedAttrs("auth.refresh", untrusted),
 *   });
 *
 * Returns `{}` when `claims` is null so callers don't have to branch.
 */
export function untrustedAttrs(prefix: string, claims: UntrustedJwtClaims | null): Record<string, string | number> {
  if (!claims) return {};
  const out: Record<string, string | number> = {};
  if (claims.sub !== undefined) out[`${prefix}.untrusted.sub`] = claims.sub;
  if (claims.exp !== undefined) out[`${prefix}.untrusted.exp`] = claims.exp;
  if (claims.iat !== undefined) out[`${prefix}.untrusted.iat`] = claims.iat;
  if (claims.jti !== undefined) out[`${prefix}.untrusted.jti`] = claims.jti;
  if (claims.type !== undefined) out[`${prefix}.untrusted.type`] = claims.type;
  return out;
}
