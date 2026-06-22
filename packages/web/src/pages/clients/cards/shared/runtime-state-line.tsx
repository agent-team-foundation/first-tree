import type { CapabilityEntry, RuntimeProvider } from "@first-tree/shared";
import { PROVIDER_LABEL, providerInstallHint, providerUnauthHint } from "./providers.js";

/**
 * Per-runtime state line — single rendering used by every card body
 * (Ready, AuthExpired, Offline). Glyph + label + version, with state
 * suffix when the runtime isn't fully usable.
 *
 * State-coded glyph colors stay in all variants: when this line is
 * stale (AuthExpired / Offline), the parent `<CardSection dimmed>`
 * lowers the whole block's opacity. Keeping the green ✓ / yellow ⚠ /
 * grey ✗ / red ! signals lets the operator tell "this runtime *was*
 * fine before we lost contact" from "this runtime was already broken"
 * at a glance once they reconnect.
 *
 * `os` is forwarded to `providerUnauthHint` in the `unauthenticated`
 * branch so the user sees a concrete recovery command keyed to the
 * machine ("Run `codex login` on this Mac.") instead of a generic
 * "needs login" — that hint was load-bearing in the pre-D3 Ready card
 * and dropping it would be a real product regression.
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
  const runtimeSuffix = entry.runtimeSource === "path" ? " · system CLI fallback" : "";
  switch (entry.state) {
    case "ok":
      return (
        <div className="text-body" style={{ color: "var(--fg-2)" }}>
          <span style={{ color: "var(--success)" }}>✓</span> {label}
          {entry.sdkVersion ? ` v${entry.sdkVersion}` : ""}
          {runtimeSuffix}
        </div>
      );
    case "unauthenticated":
      return (
        <div className="text-body" style={{ color: "var(--fg-2)" }}>
          <span style={{ color: "var(--state-blocked)" }}>⚠</span> {label}
          {entry.sdkVersion ? ` v${entry.sdkVersion}` : ""}
          {runtimeSuffix} · needs login · {providerUnauthHint(provider, os)}
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
