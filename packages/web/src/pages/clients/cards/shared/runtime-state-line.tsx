import type { CapabilityEntry, RuntimeProvider } from "@first-tree/shared";
import { PROVIDER_LABEL } from "./providers.js";

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
 */
export function RuntimeStateLine({ provider, entry }: { provider: RuntimeProvider; entry: CapabilityEntry }) {
  const label = PROVIDER_LABEL[provider];
  switch (entry.state) {
    case "ok":
      return (
        <div className="text-body" style={{ color: "var(--fg-2)" }}>
          <span style={{ color: "var(--state-idle)" }}>✓</span> {label}
          {entry.sdkVersion ? ` v${entry.sdkVersion}` : ""}
        </div>
      );
    case "unauthenticated":
      return (
        <div className="text-body" style={{ color: "var(--fg-2)" }}>
          <span style={{ color: "var(--state-blocked)" }}>⚠</span> {label}
          {entry.sdkVersion ? ` v${entry.sdkVersion}` : ""} · needs login
        </div>
      );
    case "missing":
      return (
        <div className="text-body" style={{ color: "var(--fg-3)" }}>
          <span style={{ color: "var(--fg-4)" }}>✗</span> {label} · not installed
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
