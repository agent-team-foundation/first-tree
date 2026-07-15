import { isRuntimeProviderEnabled, RUNTIME_PROVIDERS, type RuntimeProvider } from "@first-tree/shared";

/**
 * Shared provider constants for runtime-related UI. Previously lived
 * locally in `clients.tsx`; extracted so the card-based IA can reuse
 * the same labels + setup commands without duplicating strings.
 *
 * Display order for runtime sections — Claude Code first because it
 * is the more common entry point, Codex second. Mirrors mockup §"Variant
 * B-2" ordering.
 *
 * Temporarily-disabled providers (`DISABLED_RUNTIME_PROVIDERS`) are filtered
 * out so they are never offered or shown across the client cards (Ready /
 * Offline / Setup-incomplete / Auth-expired) that drive their selection off
 * this list. The label / install-command maps below intentionally keep every
 * provider so an already-bound agent on a disabled runtime still renders.
 */
export const PROVIDER_ORDER: RuntimeProvider[] = [
  RUNTIME_PROVIDERS.CLAUDE_CODE,
  RUNTIME_PROVIDERS.CLAUDE_CODE_TUI,
  RUNTIME_PROVIDERS.CODEX,
  RUNTIME_PROVIDERS.CURSOR,
].filter((p) => isRuntimeProviderEnabled(p));

export const PROVIDER_LABEL: Record<RuntimeProvider, string> = {
  "claude-code": "Claude Code",
  "claude-code-tui": "Claude Code CLI",
  codex: "Codex",
  cursor: "Cursor",
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
export const PROVIDER_NPM_PACKAGE: Record<RuntimeProvider, string | null> = {
  "claude-code": "@anthropic-ai/claude-code",
  "claude-code-tui": "@anthropic-ai/claude-code",
  codex: "@openai/codex",
  // Cursor is not distributed via npm — its official installer script is the
  // only supported install path (see CURSOR_INSTALL_COMMAND).
  cursor: null,
};

/**
 * Cursor's official installer. First Tree never runs this itself — the daemon
 * does not download/install Cursor (external-only) — the card renders it for
 * the operator to run. Mirrors `CURSOR_INSTALL_COMMAND` in
 * `@first-tree/client`'s cursor-binary module (web cannot import the client
 * package, so the string is duplicated deliberately; update both together).
 */
export const CURSOR_INSTALL_COMMAND = "curl https://cursor.com/install -fsS | bash";

/**
 * Per-runtime login command shown after install. Codex prints
 * `codex login`; Claude Code prints `claude auth login`. Both accept
 * `--api-key` flavored alternatives the user discovers on the install
 * step's stdout — the card surfaces the OAuth form by default since
 * it's the documented happy path.
 */
export const PROVIDER_LOGIN_COMMAND: Record<RuntimeProvider, string> = {
  "claude-code": "claude auth login",
  "claude-code-tui": "claude auth login",
  codex: "codex login",
  cursor: "cursor-agent login",
};

/**
 * One-liner install + login command for an empty Setup-incomplete card.
 * Joined with `\n` so the CommandPanel-style pre block renders both
 * lines. The Setup-incomplete card body wraps this in a per-provider
 * box with a copy button per box.
 */
export function buildInstallCommand(provider: RuntimeProvider, os?: string | null): string {
  const npmPackage = PROVIDER_NPM_PACKAGE[provider];
  const installLine = npmPackage ? `npm install -g ${npmPackage}` : CURSOR_INSTALL_COMMAND;
  const base = `${installLine}\n${PROVIDER_LOGIN_COMMAND[provider]}`;
  if (provider === "claude-code-tui") {
    // The tmux-driven runtime additionally needs tmux (>= 3.0). tmux is not an
    // npm package, so emit the command for the host's actual package manager
    // (keyed off the client's reported OS). Unknown OS → a non-command note
    // rather than a guessed package manager.
    const tmuxCmd = tmuxInstallCommand(os);
    return `${base}\n${tmuxCmd ?? "# install tmux (>= 3.0) with your OS package manager"}`;
  }
  return base;
}

/**
 * OS-specific command to install tmux (>= 3.0), keyed off the client's reported
 * OS (`darwin` / `linux` / `win32`). tmux is not an npm package, so the right
 * command depends on the host package manager. Windows has no native tmux — it
 * runs inside WSL, so the command targets the WSL distro.
 */
export function tmuxInstallCommand(os: string | null | undefined): string | null {
  switch (os) {
    case "darwin":
      return "brew install tmux";
    case "linux":
      // apt covers Debian/Ubuntu; other distros swap the package manager
      // (dnf / pacman / …), but apt is the common default.
      return "sudo apt install tmux";
    case "win32":
    case "windows":
      // No native Windows tmux — it runs inside WSL.
      return "wsl sudo apt install tmux";
    default:
      // Unknown / unreported OS — don't assume a package manager. A real client
      // always reports `process.platform`; this only guards legacy/unknown rows,
      // where callers fall back to naming the requirement without a command.
      return null;
  }
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
 * Hint for `state="missing"`. Distinct from `entry === null` ("not
 * reported") — that case is suppressed in the Ready card entirely, so
 * the hint only shows when the SDK explicitly probed and confirmed the
 * runtime is not installed.
 *
 * `error` is the probe's verbatim resolve-stage reason. For
 * `claude-code-tui` the runtime needs BOTH the `claude` CLI and tmux
 * (>= 3.0), and the probe reports exactly which is missing ("tmux not
 * found" / "`claude` not found …"). Passing it lets the hint name only the
 * piece that is actually absent, so a machine that already has Claude Code
 * and only lacks tmux is told to install tmux — not to reinstall the CLI
 * it already has. When `error` is absent we fall back to naming both.
 */
export function providerInstallHint(
  provider: RuntimeProvider,
  os: string | null | undefined,
  error?: string | null,
): string {
  const device = osDeviceName(os);
  if (provider === "claude-code") {
    return `Run \`npm install -g @anthropic-ai/claude-code\` on this ${device}.`;
  }
  if (provider === "claude-code-tui") {
    // The probe joins per-requirement reasons (claude + tmux) into one string;
    // match on each so we can tailor the hint to what's genuinely missing. The
    // tmux command is keyed to the host OS (brew / apt / WSL).
    const claudeMissing = error == null || /claude/i.test(error);
    const tmuxMissing = error == null || /tmux/i.test(error);
    // OS-keyed tmux command (brew / apt / WSL), or null for an unknown OS — then
    // name the requirement without assuming a package manager.
    const tmuxCmd = tmuxInstallCommand(os);
    if (tmuxMissing && !claudeMissing) {
      return tmuxCmd
        ? `Run \`${tmuxCmd}\` on this ${device} (tmux >= 3.0).`
        : `Install tmux (>= 3.0) on this ${device} with your package manager.`;
    }
    if (claudeMissing && !tmuxMissing) {
      return `Run \`npm install -g @anthropic-ai/claude-code\` on this ${device}.`;
    }
    return tmuxCmd
      ? `Run \`npm install -g @anthropic-ai/claude-code\` and \`${tmuxCmd}\` (tmux >= 3.0) on this ${device}.`
      : `Run \`npm install -g @anthropic-ai/claude-code\`, then install tmux (>= 3.0) with your package manager, on this ${device}.`;
  }
  if (provider === "cursor") {
    return `Run \`${CURSOR_INSTALL_COMMAND}\` on this ${device} (official Cursor installer).`;
  }
  return `Install the OpenAI Codex CLI on this ${device}.`;
}
