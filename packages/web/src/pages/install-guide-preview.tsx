import { useState } from "react";
import { InstallGuideSheet } from "./mobile/install-guide-sheet.js";
import type { InstallGuideMode } from "./mobile/use-install-guide.js";

// DEV-only visual harness for the install ("add to home screen") sheet. Renders
// each platform variant over a tinted backdrop so tokens/layout can be checked
// in light and dark without auth or a real beforeinstallprompt event.
const MODES: ReadonlyArray<{ mode: InstallGuideMode; label: string }> = [
  { mode: "native", label: "Android (one-tap)" },
  { mode: "ios", label: "iOS (share steps)" },
  { mode: "android-manual", label: "Android (menu steps)" },
];

export function InstallGuidePreviewPage() {
  const [mode, setMode] = useState<InstallGuideMode>("ios");

  return (
    <div
      className="min-h-dvh flex flex-col items-center"
      style={{ background: "var(--bg)", padding: "var(--sp-6) var(--sp-4)", gap: "var(--sp-4)" }}
    >
      <div className="flex flex-wrap justify-center" style={{ gap: "var(--sp-2)" }}>
        {MODES.map((option) => (
          <button
            key={option.mode}
            type="button"
            onClick={() => setMode(option.mode)}
            className="transition-colors"
            style={{
              padding: "var(--sp-1_5) var(--sp-3)",
              borderRadius: "var(--radius-input)",
              border: "var(--hairline) solid var(--border)",
              background: mode === option.mode ? "var(--bg-active)" : "var(--bg-raised)",
              color: mode === option.mode ? "var(--fg)" : "var(--fg-3)",
              cursor: "pointer",
            }}
          >
            {option.label}
          </button>
        ))}
      </div>
      <p className="text-mobile-body" style={{ color: "var(--fg-3)", margin: 0 }}>
        Set the browser to a phone viewport to see the sheet as it ships.
      </p>
      <InstallGuideSheet
        mode={mode}
        onInstall={() => {
          /* preview no-op */
        }}
        onClose={() => {
          /* preview no-op: keep the sheet visible */
        }}
      />
    </div>
  );
}
