import { redactErrorPreview } from "../../runtime/provider-support/index.js";
import { isDeepseekAuthError } from "../handlers/auth-error-hint.js";

/**
 * Drop DeepSeek API key material before any auth text becomes chat-visible or
 * durable. `DEEPSEEK_API_KEY` must never appear in operator-facing errors.
 */
export function discardDeepseekAuthorizationMaterial(text: string): string {
  return text
    .replace(/"?DEEPSEEK_API_KEY"?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s&"'<>,}]+)/gi, "DEEPSEEK_API_KEY=[REDACTED]")
    .replace(/(?:^|[?&\s/#])(?:authToken|auth_token|token|code|state|auth_code)=[^\s&"'<>]+/gi, " ")
    .replace(/https?:\/\/[^\s<>"']+/gi, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** DeepSeek chat-safe auth text: strip credential material, then generic redaction. */
export function sanitizeDeepseekAuthFailureText(text: string): string {
  return redactErrorPreview(discardDeepseekAuthorizationMaterial(text), Number.POSITIVE_INFINITY);
}

/** Compact public DeepSeek auth copy after sanitization, before formatAuthHint. */
export function publicDeepseekAuthFailure(raw: string): string {
  const cleaned = sanitizeDeepseekAuthFailureText(raw);
  const firstLine = cleaned
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const summary = firstLine && isDeepseekAuthError(firstLine) ? firstLine : cleaned.replace(/\s+/g, " ").trim();
  const compact = (summary.length > 0 ? summary : "Missing DEEPSEEK_API_KEY.").slice(0, 240);
  return compact;
}
