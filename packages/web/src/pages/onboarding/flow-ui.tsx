import { Check, Copy, ExternalLink, Lock } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import type { GithubRepo } from "../../api/github.js";

/** Checklist of outcomes for the side panel: "what you'll have after this". */
export function OutcomeList({ items }: { items: readonly string[] }) {
  return (
    <ul className="flex flex-col" style={{ gap: "var(--sp-2_5)", margin: 0, padding: 0, listStyle: "none" }}>
      {items.map((item) => (
        <li key={item} className="flex items-start text-label" style={{ gap: "var(--sp-2)", color: "var(--fg-3)" }}>
          <span
            aria-hidden="true"
            className="inline-flex items-center justify-center"
            style={{
              width: "var(--sp-4)",
              height: "var(--sp-4)",
              flexShrink: 0,
              marginTop: "var(--sp-0_5)",
              borderRadius: 999,
              background: "color-mix(in oklch, var(--accent) 14%, transparent)",
              color: "var(--accent)",
            }}
          >
            <Check className="h-3 w-3" />
          </span>
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

/** Error / warning note. Tone "error" (red) or "info" (neutral accent). */
export function FlowNote({ children, tone = "error" }: { children: ReactNode; tone?: "error" | "info" }) {
  const color = tone === "error" ? "var(--state-error)" : "var(--fg-2)";
  const bg =
    tone === "error"
      ? "color-mix(in oklch, var(--state-error) 12%, transparent)"
      : "color-mix(in oklch, var(--accent) 8%, transparent)";
  const border =
    tone === "error"
      ? "color-mix(in oklch, var(--state-error) 28%, transparent)"
      : "color-mix(in oklch, var(--accent) 22%, transparent)";
  return (
    <div
      className="text-label"
      style={{
        padding: "var(--sp-2_5) var(--sp-3)",
        background: bg,
        border: `var(--hairline) solid ${border}`,
        borderRadius: "var(--radius-input)",
        color,
      }}
    >
      {children}
    </div>
  );
}

/** Waiting / connected status row with a pulsing or solid dot. */
export function StatusRow({ state, label }: { state: "waiting" | "ok"; label: ReactNode }) {
  return (
    <div
      className="inline-flex items-center text-label"
      style={{
        gap: "var(--sp-2)",
        color: state === "ok" ? "color-mix(in oklch, var(--accent) 28%, var(--fg))" : "var(--fg-3)",
      }}
    >
      {state === "ok" ? (
        <Check className="h-3.5 w-3.5" />
      ) : (
        <span aria-hidden="true" style={{ position: "relative", display: "inline-block", width: 8, height: 8 }}>
          <span style={{ position: "absolute", inset: 0, borderRadius: "50%", background: "var(--accent)" }} />
          <span
            style={{
              position: "absolute",
              inset: -3,
              borderRadius: "50%",
              border: "var(--hairline) solid var(--accent)",
              animation: "ring-pulse 1.8s infinite",
              opacity: 0.55,
            }}
          />
        </span>
      )}
      <span>{label}</span>
    </div>
  );
}

/**
 * The terminal one-liner the user pastes to connect a computer. Shows a
 * shortened preview but copies the full multi-line command (npm install +
 * login). Lifted from the legacy Step2Body CommandBox.
 */
export function CommandBox({ command }: { command: string | null }) {
  const [copied, setCopied] = useState(false);
  const lines = command ? command.split("\n") : [];
  const connectLine = lines.find((l) => l.startsWith("first-tree")) ?? "";
  const prefix = "first-tree login ";
  const preview = connectLine.startsWith(prefix)
    ? `${prefix}${connectLine.slice(prefix.length, prefix.length + 22)}…`
    : connectLine.length > 52
      ? `${connectLine.slice(0, 52)}…`
      : connectLine;

  const handleCopy = async (): Promise<void> => {
    if (!command) return;
    await navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex" style={{ gap: "var(--sp-2)", alignItems: "stretch" }}>
      <pre
        className="mono text-label"
        title={connectLine}
        style={{
          flex: 1,
          minHeight: 38,
          margin: 0,
          padding: "var(--sp-2_5) var(--sp-3)",
          background: "color-mix(in oklch, var(--bg-sunken) 42%, transparent)",
          border: "var(--hairline) solid color-mix(in oklch, var(--border-faint) 58%, transparent)",
          borderRadius: "var(--radius-input)",
          color: "var(--fg-2)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          minWidth: 0,
          display: "flex",
          alignItems: "center",
        }}
      >
        {preview || "Generating command…"}
      </pre>
      <button
        type="button"
        onClick={handleCopy}
        disabled={!command}
        className="inline-flex items-center justify-center text-label font-medium"
        style={{
          gap: "var(--sp-1_5)",
          padding: "0 var(--sp-3)",
          minHeight: 38,
          background: "color-mix(in oklch, var(--bg-raised) 48%, transparent)",
          border: "var(--hairline) solid color-mix(in oklch, var(--border) 58%, transparent)",
          borderRadius: "var(--radius-input)",
          color: "var(--fg-2)",
          cursor: command ? "pointer" : "not-allowed",
          opacity: command ? 1 : 0.6,
        }}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/**
 * Multi-select project picker over the user's GitHub repos. Identity key is
 * `cloneUrl` (what gets bound). Beginner-friendly: shows the familiar
 * `owner/name`, a private padlock, and an open-in-GitHub affordance.
 */
export function RepoPicker({
  repos,
  selected,
  onToggle,
}: {
  repos: readonly GithubRepo[];
  selected: readonly string[];
  onToggle: (cloneUrl: string) => void;
}) {
  return (
    <div
      className="flex flex-col"
      style={{
        gap: "var(--sp-1)",
        maxHeight: 320,
        overflowY: "auto",
        padding: "var(--sp-1)",
        border: "var(--hairline) solid var(--border-faint)",
        borderRadius: "var(--radius-input)",
      }}
    >
      {repos.map((repo) => {
        const active = selected.includes(repo.cloneUrl);
        return (
          <label
            key={repo.cloneUrl}
            className="flex items-center text-body"
            style={{
              gap: "var(--sp-2_5)",
              padding: "var(--sp-2) var(--sp-2_5)",
              borderRadius: "var(--radius-input)",
              cursor: "pointer",
              background: active ? "color-mix(in oklch, var(--accent) 8%, transparent)" : "transparent",
              color: active ? "var(--fg)" : "var(--fg-2)",
            }}
          >
            <input type="checkbox" checked={active} onChange={() => onToggle(repo.cloneUrl)} className="sr-only" />
            <span
              aria-hidden="true"
              className="inline-flex items-center justify-center"
              style={{
                width: "var(--sp-4)",
                height: "var(--sp-4)",
                flexShrink: 0,
                borderRadius: "var(--radius-input)",
                border: active ? "var(--hairline) solid var(--accent)" : "var(--hairline) solid var(--border-strong)",
                background: active ? "var(--accent)" : "transparent",
                color: "var(--bg)",
              }}
            >
              {active && <Check className="h-3 w-3" />}
            </span>
            <span
              className="font-medium"
              style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >
              {repo.fullName}
            </span>
            {repo.private && <Lock className="h-3.5 w-3.5" style={{ color: "var(--fg-4)", flexShrink: 0 }} />}
            <a
              href={repo.htmlUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              style={{ color: "var(--fg-4)", flexShrink: 0, display: "inline-flex" }}
              aria-label={`Open ${repo.fullName} on GitHub`}
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </label>
        );
      })}
    </div>
  );
}
