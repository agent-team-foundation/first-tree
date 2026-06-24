import type { CapabilityEntry, RuntimeProvider } from "@first-tree/shared";
import { RuntimeAuthControls } from "./runtime-auth-controls.js";
import { deriveRuntimeAuthView } from "./runtime-auth-view.js";
import { RuntimeInstallBox } from "./runtime-install-box.js";
import { RuntimeStateLine } from "./runtime-state-line.js";

/**
 * One provider's row in a card's vertical Runtimes list: the status line, then
 * the appropriate in-place action beneath it. Shared by Ready and
 * Setup-incomplete so an unauthenticated→Connect provider renders IDENTICALLY
 * regardless of whether another runtime happens to be `ok` — that asymmetry (a
 * bare grid Connect panel on Setup-incomplete vs a stacked status-line+Connect
 * on Ready) was the layout inconsistency this collapses.
 *
 * Per state:
 *   - connectable (unauthenticated, daemon can drive login) → status line + Connect.
 *   - missing / error / never-reported, when `showInstallBox` → the
 *     copy-pasteable install box ONLY (its own labelled header replaces the
 *     status line, which would just repeat the same install instruction).
 *   - ok, or any state with no in-place action → status line only.
 *
 * `entry` may be null (a provider the daemon never reported) — only meaningful
 * with `showInstallBox`, where it renders the "install + login" box. Ready
 * passes only reported entries.
 */
export function RuntimeProviderRow({
  clientId,
  provider,
  entry,
  os,
  hostname,
  showInstallBox = false,
}: {
  clientId: string;
  provider: RuntimeProvider;
  entry: CapabilityEntry | null;
  os?: string | null;
  /** Host label for the install box copy; only consulted when `showInstallBox`. */
  hostname?: string;
  showInstallBox?: boolean;
}) {
  const view = deriveRuntimeAuthView(provider, entry, Date.now());
  const needsInstall = showInstallBox && (entry == null || entry.state === "missing" || entry.state === "error");
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-1_5)" }}>
      {entry != null && !needsInstall && <RuntimeStateLine provider={provider} entry={entry} os={os} />}
      {view.kind !== "none" && <RuntimeAuthControls clientId={clientId} provider={provider} entry={entry} />}
      {needsInstall && hostname != null && (
        <RuntimeInstallBox provider={provider} entry={entry} hostname={hostname} os={os} />
      )}
    </div>
  );
}
