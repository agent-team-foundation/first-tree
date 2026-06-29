import type { CapabilityEntry, RuntimeProvider } from "@first-tree/shared";
import { PROVIDER_LABEL, providerInstallHint } from "./providers.js";

/**
 * Per-runtime state line — single rendering used by every card body
 * (Ready, AuthExpired, Offline). Glyph + label + version.
 *
 * Detection is install-only: `ok` means the provider binary is
 * installed/resolvable (NOT verified as logged-in — that surfaces later
 * as an in-chat error, not here). State-coded glyph colors stay in all
 * variants: when this line is stale (AuthExpired / Offline), the parent
 * `<CardSection dimmed>` lowers the whole block's opacity. Keeping the
 * green ✓ / grey ✗ / red ! signals lets the operator tell "this runtime
 * *was* fine before we lost contact" from "this runtime was already
 * broken" at a glance once they reconnect.
 */
export function RuntimeStateLine({
  provider,
  entry,
  os,
}: {
  provider: RuntimeProvider;
  entry: CapabilityEntry;
  /** Host OS, passed through to per-state recovery hints. */
  os?: string | null;
}) {
  const label = PROVIDER_LABEL[provider];
  switch (entry.state) {
    case "ok":
      // Install-only detection: a system `claude`/`codex` resolved on PATH is the
      // normal case (both engines are external by default), not a "fallback", so
      // the `runtimeSource` provenance is no longer surfaced as UI copy here.
      return (
        <div className="text-body" style={{ color: "var(--fg-2)" }}>
          <span style={{ color: "var(--success)" }}>✓</span> {label} installed
          {entry.sdkVersion ? ` v${entry.sdkVersion}` : ""}
        </div>
      );
    case "missing":
      // Lead with the concrete install action keyed to what the probe found
      // missing — for `claude-code-tui` that may be only tmux, so a bare "not
      // installed" would wrongly tell a Claude-Code-equipped machine to
      // reinstall the CLI it already has. `entry.error` carries the probe's
      // per-requirement reason; `providerInstallHint` narrows on it.
      return (
        <div className="text-body" style={{ color: "var(--fg-3)" }}>
          <span style={{ color: "var(--fg-4)" }}>✗</span> {label} · {providerInstallHint(provider, os, entry.error)}
        </div>
      );
    case "error":
      return (
        <div className="text-body" style={{ color: "var(--fg-2)" }}>
          <span style={{ color: "var(--state-error)" }}>!</span> {label} · {entry.error ?? "probe failed"}
        </div>
      );
  }
}
