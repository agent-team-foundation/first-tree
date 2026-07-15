/**
 * Error taxonomy — the single source of truth for "what kind of error is
 * this, and what should the caller do about it".
 *
 * Callers wrap their catch blocks with {@link classify}, then dispatch on the
 * returned {@link Classification}. Three buckets:
 *
 *  - `transient`  : something will probably work if we wait (rate limit, 5xx,
 *                   socket reset). Retry with the suggested backoff strategy.
 *  - `degraded`   : a per-resource capability is gone but the process is fine
 *                   (agent revoked, org mismatch). Stop retrying THIS resource
 *                   but keep everything else running.
 *  - `permanent`  : recovery requires human intervention (auth rejected, config
 *                   mismatch). Surface to the operator and stop retrying.
 *
 * The function deliberately stays heuristic: we match on Anthropic SDK error
 * names, HTTP status fields, error codes (`ENOTFOUND`, `ECONNRESET`), and a
 * small set of substring patterns. Unknown errors default to `transient` with
 * a conservative cap — see {@link UNKNOWN_FALLBACK} for the rationale.
 */

import { isCodexBinaryMissingError } from "./codex-binary.js";
import { isCursorBinaryMissingError } from "./cursor-binary.js";

export const ERROR_KINDS = {
  TRANSIENT: "transient",
  DEGRADED: "degraded",
  PERMANENT: "permanent",
} as const;

export type ErrorKind = (typeof ERROR_KINDS)[keyof typeof ERROR_KINDS];

export type ErrorSource = "session" | "auth" | "bind" | "update" | "stream" | "config";

export type RetryStrategy =
  | { kind: "exponentialBackoff"; baseMs: number; capMs: number; jitter: boolean }
  | { kind: "none" };

export type Classification = {
  kind: ErrorKind;
  strategy: RetryStrategy;
  /** Stable machine-readable code; safe to log / route on. */
  reasonCode: string;
  /** Short human-readable summary; safe to embed in logs but NOT chat. */
  message: string;
};

/**
 * Compute the delay before retry attempt `attempt` (1-based) under the
 * supplied {@link RetryStrategy}. Caller responsibility:
 *  - decide when to call (no implicit timer here),
 *  - keep their own `attempt` counter so the function stays pure.
 */
export function nextRetryDelayMs(strategy: RetryStrategy, attempt: number): number {
  if (strategy.kind === "none") return 0;
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const raw = strategy.baseMs * 2 ** (safeAttempt - 1);
  const bounded = Math.min(raw, strategy.capMs);
  if (!strategy.jitter) return bounded;
  // ±20% jitter so a wave of clients waking on the same Retry-After don't
  // synchronise their retries.
  const jitterFactor = 1 + 0.2 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(bounded * jitterFactor));
}

const TRANSIENT_FAST: RetryStrategy = { kind: "exponentialBackoff", baseMs: 1_000, capMs: 5 * 60_000, jitter: true };
const TRANSIENT_BIND: RetryStrategy = { kind: "exponentialBackoff", baseMs: 2_000, capMs: 5 * 60_000, jitter: true };
const TRANSIENT_NPM: RetryStrategy = { kind: "exponentialBackoff", baseMs: 10_000, capMs: 10 * 60_000, jitter: true };
const UNKNOWN_FALLBACK: RetryStrategy = { kind: "exponentialBackoff", baseMs: 5_000, capMs: 60_000, jitter: true };
const NONE: RetryStrategy = { kind: "none" };

type ErrorShape = {
  name?: string;
  message?: string;
  code?: string | number;
  status?: number;
  statusCode?: number;
  reason?: string;
  cause?: unknown;
};

function readErrorShape(err: unknown): ErrorShape {
  if (err instanceof Error) {
    const out: ErrorShape = { name: err.name, message: err.message };
    const anyErr = err as unknown as Record<string, unknown>;
    if (typeof anyErr.code === "string" || typeof anyErr.code === "number") out.code = anyErr.code as string | number;
    if (typeof anyErr.status === "number") out.status = anyErr.status;
    if (typeof anyErr.statusCode === "number") out.statusCode = anyErr.statusCode;
    if (typeof anyErr.reason === "string") out.reason = anyErr.reason;
    if (anyErr.cause !== undefined) out.cause = anyErr.cause;
    return out;
  }
  if (typeof err === "string") return { message: err };
  if (err && typeof err === "object") {
    const anyErr = err as Record<string, unknown>;
    return {
      name: typeof anyErr.name === "string" ? anyErr.name : undefined,
      message: typeof anyErr.message === "string" ? anyErr.message : JSON.stringify(err),
      code:
        typeof anyErr.code === "string" || typeof anyErr.code === "number"
          ? (anyErr.code as string | number)
          : undefined,
      status: typeof anyErr.status === "number" ? anyErr.status : undefined,
      statusCode: typeof anyErr.statusCode === "number" ? anyErr.statusCode : undefined,
      reason: typeof anyErr.reason === "string" ? anyErr.reason : undefined,
    };
  }
  return { message: String(err) };
}

function lower(s: string | undefined): string {
  return (s ?? "").toLowerCase();
}

function statusOf(shape: ErrorShape): number | null {
  return shape.status ?? shape.statusCode ?? null;
}

/**
 * Classify an arbitrary thrown value. `context.source` lets us specialise on
 * the caller (e.g. an `auth_rejected` bind reason is `degraded`, while the
 * same reason from auth handshake is `permanent`).
 */
export function classify(err: unknown, context?: { source?: ErrorSource }): Classification {
  const shape = readErrorShape(err);
  const source = context?.source;

  // -- Bind reject reasons (string-typed `reason`, comes straight from server)
  if (source === "bind") {
    const reason = shape.reason ?? shape.message ?? "";
    return classifyBindReason(reason);
  }

  // -- Auth -----------------------------------------------------------------
  if (source === "auth") {
    if (shape.name === "AuthRefreshFailedError" || /auth[_:]rejected/i.test(shape.message ?? "")) {
      return {
        kind: ERROR_KINDS.PERMANENT,
        strategy: NONE,
        reasonCode: "auth_rejected",
        message: shape.message ?? "Auth rejected by server",
      };
    }
    if (shape.name === "AuthRefreshRateLimitedError" || /rate.?limit/i.test(shape.message ?? "")) {
      return {
        kind: ERROR_KINDS.TRANSIENT,
        strategy: TRANSIENT_FAST,
        reasonCode: "auth_rate_limited",
        message: shape.message ?? "Auth refresh rate limited",
      };
    }
    if (/expired/i.test(shape.message ?? "") || shape.name === "AuthExpiredError") {
      return {
        kind: ERROR_KINDS.TRANSIENT,
        strategy: TRANSIENT_FAST,
        reasonCode: "auth_expired",
        message: shape.message ?? "Auth token expired",
      };
    }
    // Network / DNS noise on the refresh round-trip: still transient.
    if (isNetworkErrorShape(shape)) {
      return {
        kind: ERROR_KINDS.TRANSIENT,
        strategy: TRANSIENT_FAST,
        reasonCode: "auth_network_error",
        message: shape.message ?? "Auth network error",
      };
    }
  }

  // -- Update / npm install -------------------------------------------------
  if (source === "update") {
    const codeText = lower(String(shape.code ?? ""));
    const text = lower(shape.message);
    if (/ebadengine/.test(codeText) || /ebadengine/.test(text)) {
      return {
        kind: ERROR_KINDS.PERMANENT,
        strategy: NONE,
        reasonCode: "npm_ebadengine",
        message: shape.message ?? "Node engine mismatch",
      };
    }
    if (/eacces|eperm/.test(codeText) || /permission denied/.test(text)) {
      return {
        kind: ERROR_KINDS.PERMANENT,
        strategy: NONE,
        reasonCode: "npm_permission_denied",
        message: shape.message ?? "npm install permission denied",
      };
    }
    if (/e404|404 not found|notarget/.test(text) || /e404|enoversions|notarget/.test(codeText)) {
      return {
        kind: ERROR_KINDS.PERMANENT,
        strategy: NONE,
        reasonCode: "npm_version_not_found",
        message: shape.message ?? "npm package version not found",
      };
    }
    if (isNetworkErrorShape(shape) || /etimedout|enotfound|econnreset|network/i.test(`${codeText} ${text}`)) {
      return {
        kind: ERROR_KINDS.TRANSIENT,
        strategy: TRANSIENT_NPM,
        reasonCode: "npm_network_error",
        message: shape.message ?? "npm install network error",
      };
    }
    // Unknown npm errors — let UpdateManager re-try later with the same cap
    // as other network errors so we don't burn CPU rebuilding on a
    // genuinely broken package.
    return {
      kind: ERROR_KINDS.TRANSIENT,
      strategy: TRANSIENT_NPM,
      reasonCode: "npm_unknown",
      message: shape.message ?? "npm install failed",
    };
  }

  // -- Config fetch (agent bring-up) ----------------------------------------
  // A deterministic 4xx from `/agent/config` does not self-heal: the agent row
  // and its config row are created in the same DB transaction, so a 404 means
  // the agent is gone, and 401/403 mean the member JWT is rejected — a human
  // must act. 408 (timeout) and 429 (rate limit) are the retryable 4xx and
  // fall through to the transient handlers below, as do 5xx / network /
  // unknown failures.
  if (source === "config") {
    const status = statusOf(shape);
    if (status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429) {
      const unauthorized = status === 401 || status === 403;
      return {
        kind: ERROR_KINDS.PERMANENT,
        strategy: NONE,
        reasonCode: unauthorized ? "config_unauthorized" : "config_rejected",
        message: shape.message ?? `Agent config request rejected (${status})`,
      };
    }
  }

  // -- Permanent shapes by error class --------------------------------------
  // Check class names FIRST so they win over loose substring heuristics
  // (e.g. "fetch failed" in an unrelated message accidentally classifying a
  // permanent identity error as transient network).
  if (
    shape.name === "ClientUserMismatchError" ||
    shape.name === "ClientOrgMismatchError" ||
    shape.name === "ClientRetiredError"
  ) {
    return {
      kind: ERROR_KINDS.PERMANENT,
      strategy: NONE,
      reasonCode: "client_identity_mismatch",
      message: shape.message ?? "Client identity mismatch",
    };
  }
  if (shape.name === "AuthRefreshFailedError") {
    return {
      kind: ERROR_KINDS.PERMANENT,
      strategy: NONE,
      reasonCode: "auth_refresh_failed",
      message: shape.message ?? "Refresh token rejected",
    };
  }
  // The claude-code-tui runtime throws this when its detached `claude` start
  // parks on an interactive login / re-auth wall it cannot keystroke past. No
  // amount of retrying fixes it — a human must re-authenticate — so it's
  // permanent (stops the otherwise-infinite transient retry loop and surfaces
  // the session as errored).
  if (shape.name === "ClaudeTuiLoginRequiredError") {
    return {
      kind: ERROR_KINDS.PERMANENT,
      strategy: NONE,
      reasonCode: "claude_login_required",
      message: shape.message ?? "Claude Code CLI requires re-authentication (run /login)",
    };
  }
  // A *present* codex binary whose `--version` smoke check flaked (spawn
  // timeout / host pressure) is transient — retry the bring-up. This MUST win
  // over the missing-binary check below so a busy host never masquerades as an
  // uninstalled codex (which would terminate the session with no retry).
  if (shape.name === "CodexBinaryVerifyTransientError") {
    return {
      kind: ERROR_KINDS.TRANSIENT,
      strategy: TRANSIENT_FAST,
      reasonCode: "codex_verify_transient",
      message: shape.message ?? "codex --version smoke check did not complete (transient)",
    };
  }
  if (isCodexBinaryMissingError(err)) {
    return {
      kind: ERROR_KINDS.PERMANENT,
      strategy: NONE,
      reasonCode: "codex_binary_missing",
      message: shape.message ?? "Codex runtime binary missing",
    };
  }
  // Same present-but-flaky vs genuinely-missing split for the external Cursor
  // Agent CLI: a smoke-check flake retries, a resolved-nothing / clean-broken
  // binary is a permanent capability failure.
  if (shape.name === "CursorBinaryVerifyTransientError") {
    return {
      kind: ERROR_KINDS.TRANSIENT,
      strategy: TRANSIENT_FAST,
      reasonCode: "cursor_verify_transient",
      message: shape.message ?? "cursor-agent --version smoke check did not complete (transient)",
    };
  }
  if (isCursorBinaryMissingError(err)) {
    return {
      kind: ERROR_KINDS.PERMANENT,
      strategy: NONE,
      reasonCode: "cursor_binary_missing",
      message: shape.message ?? "Cursor Agent CLI binary missing",
    };
  }
  // `AbortSignal.timeout()` aborts with a `DOMException` whose `name` is
  // `TimeoutError` (Web spec, Node 22+) and message "The operation was aborted
  // due to timeout" — a clearly transient backend/SDK timeout. Recognise it
  // explicitly so it retries on the fast transient strategy instead of falling
  // into the `unknown` bucket with a slow, mislabelled backoff. (The hub-fetch
  // path in `sdk.ts` already treats this shape as a timeout; this keeps the
  // provider-side taxonomy consistent with it.)
  if (shape.name === "TimeoutError" || /operation was aborted due to timeout/i.test(shape.message ?? "")) {
    return {
      kind: ERROR_KINDS.TRANSIENT,
      strategy: TRANSIENT_FAST,
      reasonCode: "operation_timeout",
      message: shape.message ?? "Operation aborted due to timeout",
    };
  }
  // -- Anthropic SDK / stream errors ---------------------------------------
  // RateLimitError (429) — name is contributed by the SDK; substrings are
  // fallbacks for proxied / wrapped errors that drop the class identity.
  if (shape.name === "RateLimitError" || statusOf(shape) === 429 || /rate.?limit/i.test(shape.message ?? "")) {
    return {
      kind: ERROR_KINDS.TRANSIENT,
      strategy: TRANSIENT_FAST,
      reasonCode: "claude_rate_limit",
      message: shape.message ?? "Claude API rate limit",
    };
  }
  if (
    shape.name === "InternalServerError" ||
    (statusOf(shape) ?? 0) >= 500 ||
    /overloaded|server error/i.test(shape.message ?? "")
  ) {
    return {
      kind: ERROR_KINDS.TRANSIENT,
      strategy: TRANSIENT_FAST,
      reasonCode: "claude_server_error",
      message: shape.message ?? "Claude API server error",
    };
  }
  // Stream-side socket / fetch failures (covers the "socket connection was
  // closed unexpectedly" message users see embedded in chat).
  if (
    /socket connection was closed/i.test(shape.message ?? "") ||
    /apiconnection/i.test(shape.name ?? "") ||
    /fetch failed/i.test(shape.message ?? "")
  ) {
    return {
      kind: ERROR_KINDS.TRANSIENT,
      strategy: TRANSIENT_FAST,
      reasonCode: "claude_socket_closed",
      message: shape.message ?? "Claude API connection dropped",
    };
  }
  if (isNetworkErrorShape(shape)) {
    return {
      kind: ERROR_KINDS.TRANSIENT,
      strategy: TRANSIENT_FAST,
      reasonCode: "network_error",
      message: shape.message ?? "Network error",
    };
  }

  // -- Stream tail: API error text that arrived as a "success" payload ------
  if (source === "stream" && /api error/i.test(shape.message ?? "")) {
    // Map to claude_socket_closed by default; specific status codes
    // (401/403) are upgraded to permanent below.
    const upper = shape.message ?? "";
    if (/401|403|unauthorized|forbidden/i.test(upper)) {
      return {
        kind: ERROR_KINDS.PERMANENT,
        strategy: NONE,
        reasonCode: "claude_unauthorized",
        message: shape.message ?? "Claude API unauthorized",
      };
    }
    return {
      kind: ERROR_KINDS.TRANSIENT,
      strategy: TRANSIENT_FAST,
      reasonCode: "claude_socket_closed",
      message: shape.message ?? "Claude API stream error",
    };
  }

  // -- Fallback: unknown -> transient with conservative cap -----------------
  return {
    kind: ERROR_KINDS.TRANSIENT,
    strategy: UNKNOWN_FALLBACK,
    reasonCode: "unknown",
    message: shape.message ?? "Unknown error",
  };
}

function classifyBindReason(reason: string): Classification {
  switch (reason) {
    case "wrong_client":
    case "not_owned":
      return {
        kind: ERROR_KINDS.TRANSIENT,
        strategy: TRANSIENT_BIND,
        reasonCode: `bind_${reason}`,
        message: `bind rejected: ${reason}`,
      };
    case "agent_suspended":
    case "wrong_org":
    case "unknown_agent":
    case "runtime_provider_mismatch":
      return {
        kind: ERROR_KINDS.DEGRADED,
        strategy: NONE,
        reasonCode: `bind_${reason}`,
        message: `bind rejected: ${reason}`,
      };
    default:
      return {
        kind: ERROR_KINDS.TRANSIENT,
        strategy: TRANSIENT_BIND,
        reasonCode: "bind_unknown",
        message: `bind rejected: ${reason || "unknown"}`,
      };
  }
}

function isNetworkErrorShape(shape: ErrorShape): boolean {
  const codeText = String(shape.code ?? "");
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH/.test(codeText)) return true;
  const msg = shape.message ?? "";
  return /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|fetch failed|socket hang up/i.test(msg);
}

/** Convenience: a permanent classification at infinity — caller stops retrying. */
export const NEVER_RETRY_AT_MS = Number.MAX_SAFE_INTEGER;

/** Bound a retry attempt counter so it can't overflow {@link nextRetryDelayMs}. */
export function clampRetryAttempt(attempt: number): number {
  // 2^30 is already past any reasonable cap (≈ 12 days); past that the math
  // is still safe but the value is meaningless.
  return Math.min(Math.max(1, Math.floor(attempt)), 30);
}
