import { trackEvent } from "../analytics.js";

const AUTH_ATTEMPT_KEY = "first-tree:auth-attempt";

export type AuthProvider = "google" | "github";
export type AuthEntryPoint = "login" | "deep_link" | "invite" | "campaign";
export type AuthJoinPath = "solo" | "invite" | "returning" | "unknown";
export type AuthFailureReason =
  | "state-expired"
  | "provider-denied"
  | "provider-not-configured"
  | "provider-exchange-failed"
  | "identity-conflict"
  | "identity-mismatch"
  | "last-provider"
  | "github-exchange-failed"
  | "install-not-admin"
  | "install-not-verified"
  | "install-bind-failed"
  | "invite-invalid"
  | "invite-not-allowed"
  | "invite-required"
  | "membership-unresolved"
  | "missing_tokens"
  | "session_bootstrap_failed"
  | "unknown";

type StoredAuthAttempt = {
  id: string;
  provider: AuthProvider;
  entryPoint: AuthEntryPoint;
  scanAttemptId?: string;
  variant?: string;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const VARIANT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

const CALLBACK_FAILURE_REASONS = new Set<AuthFailureReason>([
  "state-expired",
  "provider-denied",
  "provider-not-configured",
  "provider-exchange-failed",
  "identity-conflict",
  "identity-mismatch",
  "last-provider",
  "github-exchange-failed",
  "install-not-admin",
  "install-not-verified",
  "install-bind-failed",
  "invite-invalid",
  "invite-not-allowed",
  "invite-required",
  "membership-unresolved",
]);

/** Collapse redirect targets into a small acquisition-safe taxonomy. */
export function authEntryPoint(next: string): AuthEntryPoint {
  if (next.startsWith("/quickstart")) return "campaign";
  if (next.startsWith("/invite/")) return "invite";
  if (next === "/") return "login";
  return "deep_link";
}

export function authProviderForCallbackPath(pathname: string): AuthProvider {
  return pathname === "/auth/complete" ? "google" : "github";
}

export function normalizeAuthFailureReason(value: string | null): AuthFailureReason {
  if (!value) return "unknown";
  return CALLBACK_FAILURE_REASONS.has(value as AuthFailureReason) ? (value as AuthFailureReason) : "unknown";
}

export function normalizeAuthJoinPath(value: string | null): AuthJoinPath {
  return value === "solo" || value === "invite" || value === "returning" ? value : "unknown";
}

function campaignAttribution(next: string): Pick<StoredAuthAttempt, "scanAttemptId" | "variant"> | null {
  let parsed: URL;
  try {
    parsed = new URL(next, "https://cloud.first-tree.ai");
  } catch {
    return null;
  }
  if (parsed.pathname !== "/quickstart") return null;
  const scanAttemptId = parsed.searchParams.get("attempt") ?? "";
  const variant = parsed.searchParams.get("variant") ?? "";
  if (!UUID_RE.test(scanAttemptId) || !VARIANT_RE.test(variant)) return null;
  return { scanAttemptId, variant };
}

function readAttempt(): StoredAuthAttempt | null {
  if (typeof window === "undefined") return null;
  const raw = window.sessionStorage.getItem(AUTH_ATTEMPT_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredAuthAttempt>;
    if (
      typeof parsed.id !== "string" ||
      (parsed.provider !== "google" && parsed.provider !== "github") ||
      !parsed.entryPoint ||
      !["login", "deep_link", "invite", "campaign"].includes(parsed.entryPoint) ||
      (parsed.scanAttemptId !== undefined && !UUID_RE.test(parsed.scanAttemptId)) ||
      (parsed.variant !== undefined && !VARIANT_RE.test(parsed.variant))
    ) {
      throw new Error("invalid auth attempt");
    }
    return parsed as StoredAuthAttempt;
  } catch {
    window.sessionStorage.removeItem(AUTH_ATTEMPT_KEY);
    return null;
  }
}

/**
 * Start one anonymous OAuth attempt. The UUID survives the full-page provider
 * round-trip in sessionStorage, so start/result remain joinable even if GA's
 * client session is interrupted by OAuth.
 */
export function beginAuthAttempt(provider: AuthProvider, next: string): string | null {
  if (typeof window === "undefined") return null;
  const attempt: StoredAuthAttempt = {
    id: window.crypto.randomUUID(),
    provider,
    entryPoint: authEntryPoint(next),
    ...(campaignAttribution(next) ?? {}),
  };
  window.sessionStorage.setItem(AUTH_ATTEMPT_KEY, JSON.stringify(attempt));
  trackEvent("auth_started", {
    auth_attempt_id: attempt.id,
    provider,
    entry_point: attempt.entryPoint,
    ...(attempt.scanAttemptId ? { scan_attempt_id: attempt.scanAttemptId } : {}),
    ...(attempt.variant ? { variant: attempt.variant } : {}),
  });
  return attempt.id;
}

export function finishAuthAttempt(input: {
  provider: AuthProvider;
  result: "success" | "failed";
  next: string;
  joinPath?: AuthJoinPath;
  reasonCode?: AuthFailureReason;
  accountCreated?: boolean | null;
}): void {
  if (typeof window === "undefined") return;
  const stored = readAttempt();
  const attempt = stored?.provider === input.provider ? stored : null;
  // A callback without its matching anonymous start is not part of the
  // acquisition funnel. Besides keeping start/result joinable, this makes
  // completion idempotent across reloads and preserves an attempt when a
  // different provider completes. Explicit non-sign-in flows are filtered
  // by the callback page before reaching this helper.
  if (!attempt) return;
  const entryPoint = attempt.entryPoint;
  const params: Record<string, unknown> = {
    provider: input.provider,
    result: input.result,
    entry_point: entryPoint,
    join_path: input.joinPath ?? "unknown",
    account_type: input.accountCreated === true ? "created" : input.accountCreated === false ? "reused" : "unknown",
    auth_attempt_id: attempt.id,
    ...(attempt.scanAttemptId ? { scan_attempt_id: attempt.scanAttemptId } : {}),
    ...(attempt.variant ? { variant: attempt.variant } : {}),
    ...(input.reasonCode ? { reason_code: input.reasonCode } : {}),
  };
  trackEvent("auth_result", params);
  // GA's recommended sign_up event belongs to account creation, not to a
  // later onboarding-completion proxy. This also counts a newly-created
  // invitee account whose join path is not "solo".
  if (input.accountCreated === true) {
    trackEvent("sign_up", {
      method: input.provider,
      entry_point: entryPoint,
      auth_attempt_id: attempt.id,
      ...(attempt.scanAttemptId ? { scan_attempt_id: attempt.scanAttemptId } : {}),
      ...(attempt.variant ? { variant: attempt.variant } : {}),
    });
  }
  window.sessionStorage.removeItem(AUTH_ATTEMPT_KEY);
}
