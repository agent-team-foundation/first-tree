import { redactErrorPreview } from "../../runtime/provider-support/index.js";
import { isAmpAuthError } from "../handlers/auth-error-hint.js";

/**
 * Drop complete Amp login URLs and one-time query material before any auth
 * text becomes chat-visible or durable. Official absent-key stdout prints a
 * `cli-login` URL with `authToken`; First Tree must not retain that.
 *
 * `AMP_API_KEY` is Amp's host credential env. The shared `redactErrorPreview`
 * matcher treats `api_key` as a suffix of `AMP_API_KEY` (negative lookbehind),
 * so Amp must strip unquoted, shell-quoted, and JSON key/value forms here.
 */
export function discardAmpLoginAuthorizationMaterial(text: string): string {
  return text
    .replace(/https?:\/\/[^\s<>"']+/gi, "")
    .replace(/(?:^|[?&\s/#])(?:authToken|auth_token|token|code|state|auth_code)=[^\s&"'<>]+/gi, " ")
    .replace(/"?AMP_API_KEY"?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s&"'<>,}]+)/gi, "AMP_API_KEY=[REDACTED]")
    .replace(/when prompted,\s*paste your code here:?\s*/gi, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** Amp chat-safe auth text: drop login URLs/query, then generic credential redaction. */
export function sanitizeAmpAuthFailureText(text: string): string {
  return redactErrorPreview(discardAmpLoginAuthorizationMaterial(text), Number.POSITIVE_INFINITY);
}

/** Compact public Amp auth copy after sanitization, before formatAuthHint. */
export function publicAmpAuthFailure(raw: string): string {
  const cleaned = sanitizeAmpAuthFailureText(raw);
  const firstLine = cleaned
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const summary = firstLine && isAmpAuthError(firstLine) ? firstLine : cleaned.replace(/\s+/g, " ").trim();
  const compact = (summary.length > 0 ? summary : "No API key found. Run amp login.").slice(0, 240);
  return compact;
}
