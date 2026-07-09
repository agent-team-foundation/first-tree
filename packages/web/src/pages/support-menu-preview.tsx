import { SupportMenu } from "../components/support-menu.js";

/**
 * DEV-only visual preview of the top-bar support menu, mounted at
 * `/preview/support-menu` (gated by `import.meta.env.DEV` in app.tsx).
 *
 * Renders the REAL `SupportMenu` — static community links (Discord + WeChat
 * QR), so unlike /preview/user-menu it needs no faked auth context.
 */
export function SupportMenuPreviewPage() {
  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)" }}>
      <header
        className="flex items-center justify-between"
        style={{
          padding: "var(--sp-2) var(--sp-4)",
          borderBottom: "var(--hairline) solid var(--border)",
          background: "var(--bg-raised)",
        }}
      >
        <span className="text-label" style={{ color: "var(--fg-2)" }}>
          /preview/support-menu — top-bar help & community entry
        </span>
        <SupportMenu />
      </header>
      <div className="text-caption" style={{ padding: "var(--sp-4)", color: "var(--fg-3)" }}>
        <button
          type="button"
          className="text-caption mono"
          onClick={() => document.documentElement.classList.toggle("dark")}
          style={{
            padding: "var(--sp-1) var(--sp-2_5)",
            border: "var(--hairline) solid var(--border)",
            borderRadius: "var(--radius-input)",
            background: "var(--bg-raised)",
            color: "var(--fg-2)",
            cursor: "pointer",
          }}
        >
          theme
        </button>
      </div>
    </div>
  );
}
