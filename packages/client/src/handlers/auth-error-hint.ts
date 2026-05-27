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

type Runtime = "codex" | "claude-code";

/**
 * Substring keywords used to detect codex's auth-refresh failures. Codex's
 * SDK exposes only `{ message: string }` (no typed error code), so we match
 * on the english phrases that appear across every variant the bundled Rust
 * binary emits ("...refresh token was revoked...", "...refresh token has
 * expired...", "...could not be refreshed...", "...Please log out and sign
 * in again..."). Keep the keyword set narrow: each must be specific enough
 * that an unrelated SDK error wouldn't trip it.
 *
 * Claude-code does NOT use this — it ships a typed `SDKAssistantMessageError`
 * union (see `isClaudeAuthError`).
 */
const CODEX_AUTH_KEYWORDS: readonly string[] = [
  "refresh token",
  "could not be refreshed",
  "log out and sign in",
  "sign in again",
  "log in again",
  "Token data is not available",
];

export function isCodexAuthError(message: string): boolean {
  if (message.length === 0) return false;
  const lower = message.toLowerCase();
  return CODEX_AUTH_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
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
  const reauth = runtime === "codex" ? "`codex login`" : "`claude /login`";
  const provider = runtime === "codex" ? "OpenAI" : "Anthropic";
  const trimmed = originalMessage.trim();
  const original = trimmed.length > 0 ? trimmed : "(no message from SDK)";
  return (
    `${runtime} auth on this machine looks broken or expired. ` +
    `This is ${provider}'s auth state, not First Tree's — ` +
    `please run ${reauth} in your terminal to re-authenticate, then retry. ` +
    `Original SDK error: ${original}`
  );
}
