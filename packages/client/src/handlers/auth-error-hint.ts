/**
 * Translate runtime SDK auth-failure messages into a chat-timeline hint that
 * points the user at the right re-login command on their own machine.
 *
 * We never touch the runtime's credential file — codex owns `~/.codex/auth.json`
 * and claude owns its own credential store. The boundary here is one-way:
 * detect the failure, ask the user to fix it via the runtime's native CLI.
 *
 * Why this exists: a stale `~/.codex/auth.json` (e.g. from an older install or
 * a logged-out ChatGPT account) surfaces inside First Tree's chat as an
 * opaque "ERROR - SDK" line that mentions nothing First-Tree-shaped. New users
 * read it as "First Tree is broken" and have no idea the fix lives in OpenAI's
 * CLI. The hint reframes the message so the next step is obvious.
 */

type Runtime = "codex" | "claude-code" | "cursor" | "kimi-code";

/**
 * Substring keywords used to detect codex's auth-refresh failures. Codex's
 * SDK exposes only `{ message: string }` (no typed error code), so we match
 * on the english phrases that appear across every variant the bundled Rust
 * binary emits ("...refresh token was revoked...", "...refresh token has
 * expired...", "...could not be refreshed...", "...Please log out and sign
 * in again...", "...Token data is not available..."). All seven phrases
 * below were extracted via `strings` from
 * `node_modules/@openai/codex/vendor/*\/codex/codex` at codex-sdk 0.125.0.
 *
 * Order matters for auditability (not for correctness — we use `some`):
 * the most-specific phrases come first so any canonical codex message hits
 * a specific keyword before falling through to the broader "...sign in
 * again..." / "...log in again..." catches. Future codex copy changes that
 * remove a specific phrase but keep one of the generic tails will still
 * trip detection.
 *
 * Claude-code does NOT use this — it ships a typed `SDKAssistantMessageError`
 * union (see `isClaudeAuthError`).
 */
const CODEX_AUTH_KEYWORDS: readonly string[] = [
  "could not be refreshed",
  "refresh token",
  "log out and sign in",
  "Token data is not available",
  "sign in again",
  "log in again",
];

export function isCodexAuthError(message: string): boolean {
  if (message.length === 0) return false;
  const lower = message.toLowerCase();
  return CODEX_AUTH_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
}

/**
 * Cursor Agent CLI auth-failure phrases. The CLI exposes no typed error code
 * in headless mode — a logged-out turn exits 1 with stderr like
 * "Error: Authentication required. Please run 'agent login' first, or set
 * CURSOR_API_KEY environment variable." (captured verbatim in Phase 0).
 */
const CURSOR_AUTH_KEYWORDS: readonly string[] = [
  "authentication required",
  "not logged in",
  "please run 'agent login'",
  "cursor_api_key",
];

export function isCursorAuthError(message: string): boolean {
  if (message.length === 0) return false;
  const lower = message.toLowerCase();
  return CURSOR_AUTH_KEYWORDS.some((kw) => lower.includes(kw));
}

export function isKimiCodeAuthError(codeOrMessage: string): boolean {
  const lower = codeOrMessage.toLowerCase();
  return (
    lower.startsWith("auth.") ||
    lower.includes(" auth.") ||
    lower.includes("provider.auth_error") ||
    lower.includes("login required") ||
    lower.includes("not authenticated")
  );
}

/**
 * The single auth-failure code claude-code's SDK reports (out of the
 * `SDKAssistantMessageError` union). Centralised here so both the assistant-
 * message path and the api_retry path can share one check.
 */
export function isClaudeAuthError(code: string | undefined): boolean {
  return code === "authentication_failed";
}

/**
 * Build the chat-timeline message we want the user to see when an auth
 * failure is detected. Includes the raw SDK error verbatim so the user can
 * paste it into a support thread without losing detail. The hint is short
 * and points at the runtime's own CLI — we do NOT advertise a First Tree
 * UI button or relogin flow, by design.
 */
export function formatAuthHint(runtime: Runtime, originalMessage: string): string {
  // Login command mirrors `PROVIDER_LOGIN_COMMAND` in
  // packages/web/src/pages/clients/cards/shared/providers.ts so the in-chat
  // hint matches what the Setup-incomplete card already prints. Keeping them
  // textually identical is intentional — if the provider's canonical command
  // ever changes, update both call sites together.
  const reauth =
    runtime === "codex"
      ? "`codex login`"
      : runtime === "cursor"
        ? "`cursor-agent login`"
        : runtime === "kimi-code"
          ? "`kimi` and then `/login`"
          : "`claude auth login`";
  const provider =
    runtime === "codex" ? "OpenAI" : runtime === "cursor" ? "Cursor" : runtime === "kimi-code" ? "Kimi" : "Anthropic";
  // Cap the appended raw message so an upstream stack-trace envelope (codex
  // wraps its `event.error.message` in surprising ways) doesn't bloat the
  // hint into a wall of text on the chat timeline.
  const trimmed = originalMessage.trim().slice(0, ORIGINAL_MESSAGE_CAP);
  const original = trimmed.length > 0 ? trimmed : "(no message from SDK)";
  return (
    `${runtime} auth on this machine looks broken or expired. ` +
    `This is ${provider}'s auth state, not First Tree's — ` +
    `please run ${reauth} in your terminal to re-authenticate, then retry. ` +
    `Original SDK error: ${original}`
  );
}

const ORIGINAL_MESSAGE_CAP = 1000;
