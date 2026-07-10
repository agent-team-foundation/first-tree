import { join } from "node:path";

/**
 * Curated, stable install directories where a globally-installed `claude` /
 * `codex` binary commonly lands but the daemon's frozen service PATH does not
 * include. Searched (cheaply, no spawn) after the daemon PATH and the
 * login-shell PATH, so capability detection still finds the binary even when the
 * login-shell probe is unavailable.
 *
 * Covers node-version-manager shims, global-npm prefixes, and the pnpm / bun
 * global bins. macOS-only Homebrew / pnpm dirs are gated on `darwin`. Returns
 * absolute dir paths (binary name is appended by the caller, per provider).
 */
export function wellKnownBinDirs(home: string): string[] {
  const isMac = process.platform === "darwin";
  const dirs = [
    join(home, ".local", "bin"), // official native installer default
    join(home, ".claude", "local"), // `claude migrate-installer` target
    join(home, ".volta", "bin"), // volta
    join(home, ".asdf", "shims"), // asdf
    join(home, ".local", "share", "mise", "shims"), // mise
    join(home, ".npm-global", "bin"), // custom npm global prefix
    join(home, ".local", "share", "pnpm"), // pnpm global (linux/xdg)
    ...(isMac ? [join(home, "Library", "pnpm")] : []), // pnpm global (macOS)
    join(home, ".bun", "bin"), // bun global
    ...(isMac ? ["/opt/homebrew/bin"] : []), // Apple-silicon Homebrew
    "/usr/local/bin", // Intel Homebrew / common manual installs
  ];
  return dirs;
}

/**
 * macOS desktop-app resource directories that can carry the Codex CLI.
 *
 * Codex originally shipped as `/Applications/Codex.app`, then moved into the
 * ChatGPT desktop app. Keep the current name first and retain the standalone
 * app as a compatibility fallback. Per-user app installs use the same order.
 */
export function codexDesktopAppBinDirs(home: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== "darwin") return [];

  return [
    join("/Applications", "ChatGPT.app", "Contents", "Resources"),
    join(home, "Applications", "ChatGPT.app", "Contents", "Resources"),
    join("/Applications", "Codex.app", "Contents", "Resources"),
    join(home, "Applications", "Codex.app", "Contents", "Resources"),
  ];
}
