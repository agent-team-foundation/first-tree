import { RUNTIME_PROVIDERS, type RuntimeProvider } from "@first-tree/shared";

/**
 * Shared provider constants for runtime-related UI. Previously lived
 * locally in `clients.tsx`; extracted so the card-based IA can reuse
 * the same labels + setup commands without duplicating strings.
 *
 * Display order for runtime sections — Claude Code first because it
 * is the more common entry point, Codex second. Mirrors mockup §"Variant
 * B-2" ordering.
 */
export const PROVIDER_ORDER: RuntimeProvider[] = [RUNTIME_PROVIDERS.CLAUDE_CODE, RUNTIME_PROVIDERS.CODEX];

export const PROVIDER_LABEL: Record<RuntimeProvider, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

/**
 * `npm install -g` package spec per runtime. The CLI canonical install
 * command lives here so the Setup-incomplete card body can render the
 * full install + login two-step without each card duplicating strings.
 */
export const PROVIDER_NPM_PACKAGE: Record<RuntimeProvider, string> = {
  "claude-code": "@anthropic-ai/claude-code",
  codex: "@openai/codex",
};

/**
 * Per-runtime login command shown after install. Codex prints
 * `codex login`; Claude Code prints `claude login`. Both accept
 * `--api-key` flavored alternatives the user discovers on the install
 * step's stdout — the card surfaces the OAuth form by default since
 * it's the documented happy path.
 */
export const PROVIDER_LOGIN_COMMAND: Record<RuntimeProvider, string> = {
  "claude-code": "claude login",
  codex: "codex login",
};

/**
 * One-liner install + login command for an empty Setup-incomplete card.
 * Joined with `\n` so the CommandPanel-style pre block renders both
 * lines. The Setup-incomplete card body wraps this in a per-provider
 * box with a copy button per box.
 */
export function buildInstallCommand(provider: RuntimeProvider): string {
  return `npm install -g ${PROVIDER_NPM_PACKAGE[provider]}\n${PROVIDER_LOGIN_COMMAND[provider]}`;
}

/**
 * Shortest hint string for "this runtime is installed but the user
 * isn't authed". Used by Ready card's compact capability matrix when
 * one provider is `unauthenticated`. Full re-auth lives in the
 * provider's docs.
 */
export const PROVIDER_UNAUTH_HINT: Record<RuntimeProvider, string> = {
  "claude-code": "Run `claude login` (or set ANTHROPIC_API_KEY) on the computer.",
  codex: "Run `codex login` (or set CODEX_API_KEY) on the computer.",
};

export const PROVIDER_INSTALL_HINT: Record<RuntimeProvider, string> = {
  "claude-code": "Run `npm install -g @anthropic-ai/claude-code` on this computer.",
  codex: "Install the OpenAI Codex CLI on this computer.",
};
