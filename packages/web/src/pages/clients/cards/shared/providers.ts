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
export const PROVIDER_ORDER: RuntimeProvider[] = [
  RUNTIME_PROVIDERS.CLAUDE_CODE,
  RUNTIME_PROVIDERS.CLAUDE_CODE_TUI,
  RUNTIME_PROVIDERS.CODEX,
];

export const PROVIDER_LABEL: Record<RuntimeProvider, string> = {
  "claude-code": "Claude Code",
  "claude-code-tui": "Claude Code CLI",
  codex: "Codex",
};

const KNOWN_RUNTIME_PROVIDERS: readonly string[] = Object.values(RUNTIME_PROVIDERS);

/**
 * Narrow a wire-string provider to the `RuntimeProvider` enum, or null when it
 * isn't one we recognise. The enum has no runtime type guard, so this
 * includes-check is the single sanctioned narrowing point — callers get a
 * typed value or null instead of sprinkling `as` at each use site.
 */
export function asRuntimeProvider(provider: string): RuntimeProvider | null {
  // Single `as` after an includes-guard, matching the accepted pattern in
  // bound-agents-list / new-agent-dialog (the enum has no runtime type guard).
  return KNOWN_RUNTIME_PROVIDERS.includes(provider) ? (provider as RuntimeProvider) : null;
}

/** Friendly runtime label, falling back to the raw id if it isn't a known one. */
export function runtimeProviderLabel(provider: string): string {
  const known = asRuntimeProvider(provider);
  return known ? PROVIDER_LABEL[known] : provider;
}

/**
 * `npm install -g` package spec per runtime. The CLI canonical install
 * command lives here so the Setup-incomplete card body can render the
 * full install + login two-step without each card duplicating strings.
 *
 * `claude-code-tui` shares the same `claude` CLI binary as `claude-code`
 * — the difference is that the daemon drives it through tmux rather than
 * the SDK. The install command is identical; the additional tmux
 * requirement is surfaced via providerInstallHint().
 */
export const PROVIDER_NPM_PACKAGE: Record<RuntimeProvider, string> = {
  "claude-code": "@anthropic-ai/claude-code",
  "claude-code-tui": "@anthropic-ai/claude-code",
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
  "claude-code-tui": "claude login",
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
 * Friendly "this Mac / this Linux machine / this Windows PC" phrase
 * derived from the client's reported OS. Lets recovery copy address
 * the user's actual hardware instead of the generic "computer".
 *
 * Maps the kernel-side strings the SDK reports (`darwin`, `linux`,
 * `win32`). Unknown / null falls back to "computer" — never breaks the
 * sentence shape.
 */
export function osDeviceName(os: string | null | undefined): string {
  switch (os) {
    case "darwin":
      return "Mac";
    case "linux":
      return "Linux machine";
    case "win32":
    case "windows":
      return "Windows PC";
    default:
      return "computer";
  }
}

/**
 * Shortest hint for "this runtime is installed but the user isn't
 * authed". Used by Ready card's runtime line when one provider is
 * `unauthenticated`. The env-variable fallback (`ANTHROPIC_API_KEY` /
 * `CODEX_API_KEY`) is intentionally dropped — most users discover the
 * OAuth flow first, and the env var path is a footgun for newcomers
 * who'd commit the key.
 */
export function providerUnauthHint(provider: RuntimeProvider, os: string | null | undefined): string {
  return `Run \`${PROVIDER_LOGIN_COMMAND[provider]}\` on this ${osDeviceName(os)}.`;
}

/**
 * Hint for `state="missing"`. Distinct from `entry === null` ("not
 * reported") — that case is suppressed in the Ready card entirely, so
 * the hint only shows when the SDK explicitly probed and confirmed the
 * runtime is not installed.
 */
export function providerInstallHint(provider: RuntimeProvider, os: string | null | undefined): string {
  if (provider === "claude-code") {
    return `Run \`npm install -g @anthropic-ai/claude-code\` on this ${osDeviceName(os)}.`;
  }
  if (provider === "claude-code-tui") {
    // TUI shares the `claude` CLI install with `claude-code`, but additionally
    // requires `tmux` (>= 3.0) so the daemon can spawn the runtime in a
    // detached session. The capability probe in
    // `runtime/capabilities/claude-code-tui.ts` enforces both at probe time.
    return `Install \`@anthropic-ai/claude-code\` and \`tmux\` (>= 3.0) on this ${osDeviceName(os)}.`;
  }
  return `Install the OpenAI Codex CLI on this ${osDeviceName(os)}.`;
}
