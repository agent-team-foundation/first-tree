import { useEffect, useState } from "react";
import { DEMO_SCENARIOS, type DemoScenario, findDemoScenario } from "./dev-fixtures.js";

/**
 * Floating dev-only overlay rendered on `/settings/computers` when the
 * URL carries `?demo=<key>`. Lets the reviewer walk every scenario
 * inside the real page chrome (sidebar, PageHeader, ClientsPage layout)
 * without seeding the DB.
 *
 * Lives bottom-right so it doesn't compete with the page's own header.
 * Collapsible — the "What to check" list expands on click; the slim
 * resting state stays out of the way so the reviewer can scrutinize
 * the page itself.
 *
 * The component is mounted *only* when the page detects demo mode is
 * active, so the prod page bundle never reaches this code path.
 */
export function DemoNavigator({
  activeKey,
  onSelect,
  onExit,
}: {
  activeKey: string;
  onSelect: (key: string) => void;
  onExit: () => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const variant: DemoScenario | null = findDemoScenario(activeKey);
  if (!variant) return null;

  const idx = DEMO_SCENARIOS.findIndex((v) => v.key === activeKey);
  const prev = idx > 0 ? DEMO_SCENARIOS[idx - 1] : null;
  const next = idx < DEMO_SCENARIOS.length - 1 ? DEMO_SCENARIOS[idx + 1] : null;

  return (
    <aside
      aria-label="Demo navigator"
      style={{
        position: "fixed",
        right: "var(--sp-4)",
        bottom: "var(--sp-4)",
        width: 360,
        maxHeight: "70vh",
        overflowY: "auto",
        background: "var(--bg-raised)",
        border: "var(--hairline) solid var(--border)",
        borderRadius: "var(--radius-panel)",
        boxShadow: "var(--shadow-md)",
        zIndex: 60,
      }}
    >
      <header
        style={{
          padding: "var(--sp-2_5) var(--sp-3)",
          display: "flex",
          alignItems: "center",
          gap: "var(--sp-2)",
          borderBottom: "var(--hairline) solid var(--border-faint)",
        }}
      >
        <span className="text-caption" style={{ color: "var(--state-idle)", whiteSpace: "nowrap" }}>
          DEMO {idx + 1}/{DEMO_SCENARIOS.length}
        </span>
        <select
          aria-label="Scenario"
          value={variant.key}
          onChange={(e) => onSelect(e.target.value)}
          className="text-body"
          style={{
            flex: 1,
            minWidth: 0,
            padding: "var(--sp-1) var(--sp-1_5)",
            background: "var(--bg)",
            color: "var(--fg)",
            border: "var(--hairline) solid var(--border)",
            borderRadius: "var(--radius-input)",
            cursor: "pointer",
          }}
        >
          {groupVariants(DEMO_SCENARIOS).map(([group, items]) => (
            <optgroup key={group} label={group}>
              {items.map((v) => (
                <option key={v.key} value={v.key}>
                  {v.title}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <button
          type="button"
          onClick={onExit}
          title="Exit demo mode"
          className="text-caption"
          style={{
            padding: "var(--sp-1) var(--sp-2)",
            background: "transparent",
            color: "var(--fg-3)",
            border: "var(--hairline) solid var(--border)",
            borderRadius: "var(--radius-input)",
            cursor: "pointer",
          }}
        >
          Exit
        </button>
      </header>

      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        style={{
          width: "100%",
          padding: "var(--sp-2) var(--sp-3)",
          background: "transparent",
          color: "var(--fg-2)",
          border: "none",
          textAlign: "left",
          cursor: "pointer",
        }}
      >
        <div className="text-caption" style={{ color: "var(--state-idle)", marginBottom: 2 }}>
          {variant.group}
        </div>
        <div className="text-body font-semibold">{variant.title}</div>
        <div className="text-caption" style={{ color: "var(--fg-4)", marginTop: 4 }}>
          {expanded ? "▾ Hide notes" : "▸ Show notes"}
        </div>
      </button>

      {expanded && (
        <div style={{ padding: "0 var(--sp-3) var(--sp-3)" }}>
          <p className="text-caption" style={{ margin: 0, color: "var(--fg-3)", marginBottom: "var(--sp-2)" }}>
            {variant.summary}
          </p>
          <div className="text-caption" style={{ color: "var(--fg-3)", marginBottom: "var(--sp-1)" }}>
            What to check
          </div>
          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: "var(--sp-1)" }}>
            {variant.whatToCheck.map((line, i) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: static list per scenario.
                key={i}
                className="text-caption"
                style={{ color: "var(--fg-2)", display: "flex", gap: "var(--sp-1_5)" }}
              >
                <span style={{ color: "var(--fg-4)", flexShrink: 0 }}>·</span>
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <footer
        style={{
          display: "flex",
          gap: "var(--sp-2)",
          padding: "var(--sp-2_5) var(--sp-3)",
          borderTop: "var(--hairline) solid var(--border-faint)",
        }}
      >
        <button
          type="button"
          disabled={!prev}
          onClick={() => prev && onSelect(prev.key)}
          className="text-caption"
          style={{
            flex: 1,
            padding: "var(--sp-1_5) var(--sp-2)",
            background: "transparent",
            color: prev ? "var(--fg-2)" : "var(--fg-4)",
            border: "var(--hairline) solid var(--border)",
            borderRadius: "var(--radius-input)",
            cursor: prev ? "pointer" : "default",
            textAlign: "left",
          }}
        >
          ← {prev?.title.slice(0, 28) ?? "—"}
        </button>
        <button
          type="button"
          disabled={!next}
          onClick={() => next && onSelect(next.key)}
          className="text-caption"
          style={{
            flex: 1,
            padding: "var(--sp-1_5) var(--sp-2)",
            background: "transparent",
            color: next ? "var(--fg-2)" : "var(--fg-4)",
            border: "var(--hairline) solid var(--border)",
            borderRadius: "var(--radius-input)",
            cursor: next ? "pointer" : "default",
            textAlign: "right",
          }}
        >
          {next?.title.slice(0, 28) ?? "—"} →
        </button>
      </footer>
    </aside>
  );
}

/**
 * Reads `?demo=<key>` from the URL and keeps state in sync with browser
 * back/forward. Returns `null` when the param isn't set or doesn't
 * match a known scenario.
 *
 * Every branch is no-op in production: `import.meta.env.DEV` folds to
 * `false`, the initializer returns null, the popstate listener bails,
 * and the updater rejects writes — so the hook keeps a stable shape
 * (React rules-of-hooks happy) while the demo code path stays inert.
 * Combined with the gated `DEMO_SCENARIOS` array in `dev-fixtures.ts`,
 * the entire feature drops out of the prod bundle.
 */
export function useDemoScenarioParam(): [string | null, (key: string | null) => void] {
  const [key, setKey] = useState<string | null>(() => readDemoParam());

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const sync = () => setKey(readDemoParam());
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  const update = (nextKey: string | null) => {
    if (!import.meta.env.DEV) return;
    const url = new URL(window.location.href);
    if (nextKey) {
      url.searchParams.set("demo", nextKey);
    } else {
      url.searchParams.delete("demo");
    }
    window.history.pushState({}, "", url);
    setKey(nextKey);
  };

  return [key, update];
}

function readDemoParam(): string | null {
  if (!import.meta.env.DEV) return null;
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("demo");
  if (!raw) return null;
  return findDemoScenario(raw)?.key ?? null;
}

function groupVariants(variants: DemoScenario[]): Array<[string, DemoScenario[]]> {
  const map = new Map<string, DemoScenario[]>();
  for (const v of variants) {
    const list = map.get(v.group) ?? [];
    list.push(v);
    map.set(v.group, list);
  }
  return [...map.entries()];
}
