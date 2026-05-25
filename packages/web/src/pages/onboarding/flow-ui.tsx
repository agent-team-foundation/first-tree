import { Check, CircleAlert, Copy, ExternalLink, Info, Lock } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import type { GithubRepo } from "../../api/github.js";

/** Checklist of outcomes for the footer: "what you'll have after this". */
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

/**
 * Step heading (title + optional one-line "why"). Used when a step renders its
 * own heading per sub-state instead of the shell's static one — the shell
 * skips title/why when STEP_COPY leaves them empty. Spacing matches the shell's
 * heading so per-state steps line up with static ones.
 */
export function StepHeading({ title, why }: { title: string; why?: string | null }) {
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-2_5)" }}>
      <h1 className="text-title font-semibold" style={{ margin: 0, color: "var(--fg)" }}>
        {title}
      </h1>
      {why ? (
        <p className="text-body" style={{ margin: 0, color: "var(--fg-3)" }}>
          {why}
        </p>
      ) : null}
    </div>
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
  const Icon = tone === "error" ? CircleAlert : Info;
  return (
    <div
      className="flex items-start text-label"
      role={tone === "error" ? "alert" : undefined}
      style={{
        gap: "var(--sp-2)",
        padding: "var(--sp-2_5) var(--sp-3)",
        background: bg,
        border: `var(--hairline) solid ${border}`,
        borderRadius: "var(--radius-input)",
        color,
      }}
    >
      <Icon className="h-3.5 w-3.5" style={{ flexShrink: 0, marginTop: "var(--sp-0_5)" }} aria-hidden="true" />
      <span style={{ minWidth: 0 }}>{children}</span>
    </div>
  );
}

/**
 * Centered "we're working on it" state for the two waits that are the
 * emotional peaks (creating the teammate, getting it started). Three
 * breathing dots + a reassuring line; motion stilled under reduced-motion.
 */
export function WorkingState({ label, hint }: { label: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center text-center" style={{ paddingTop: "var(--sp-8)", gap: "var(--sp-4)" }}>
      <span className="inline-flex items-center" style={{ gap: "var(--sp-1_5)" }}>
        {[0, 160, 320].map((delay) => (
          <span
            key={delay}
            aria-hidden="true"
            className="onboarding-working-dot"
            style={{
              width: "var(--sp-2)",
              height: "var(--sp-2)",
              borderRadius: "50%",
              background: "var(--accent)",
              animationDelay: `${delay}ms`,
            }}
          />
        ))}
      </span>
      <p className="text-subtitle font-semibold" style={{ margin: 0, color: "var(--fg)" }}>
        {label}
      </p>
      {hint && (
        <p className="text-label" style={{ margin: 0, color: "var(--fg-4)" }}>
          {hint}
        </p>
      )}
    </div>
  );
}

/** Waiting / connected status row with a pulsing or solid dot. */
export function StatusRow({ state, label }: { state: "waiting" | "ok"; label: ReactNode }) {
  return (
    <div
      className="inline-flex items-center text-label"
      role="status"
      aria-live="polite"
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
 * The terminal one-liner the user pastes to connect a computer. Renders the
 * install + login lines filling the box width (ellipsizing only the overflow)
 * and copies the full multi-line command (npm install + login). Lifted from the
 * legacy Step2Body CommandBox.
 */
export function CommandBox({ command }: { command: string | null }) {
  const [copied, setCopied] = useState(false);
  const lines = command ? command.split("\n").filter((l) => l.trim().length > 0) : [];
  // Show both lines — install and login — each on its own row, filling the box
  // width and ellipsizing only what overflows. So the long opaque token shows
  // as much as fits (not a stingy fixed slice) and grows with the box width.
  // Copy still puts the complete multi-line command on the clipboard.
  const installLine = lines.find((l) => l.startsWith("npm")) ?? "";
  const loginLine = lines.find((l) => l.startsWith("first-tree")) ?? "";

  const handleCopy = async (): Promise<void> => {
    if (!command) return;
    await navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex" style={{ gap: "var(--sp-2)", alignItems: "stretch" }}>
      <div
        className="mono text-label"
        title={command ?? undefined}
        style={{
          flex: 1,
          minHeight: 38,
          margin: 0,
          padding: "var(--sp-2_5) var(--sp-3)",
          background: "color-mix(in oklch, var(--bg-sunken) 42%, transparent)",
          border: "var(--hairline) solid color-mix(in oklch, var(--border-faint) 58%, transparent)",
          borderRadius: "var(--radius-input)",
          color: "var(--fg-2)",
          minWidth: 0,
          lineHeight: 1.65,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          gap: "var(--sp-0_5)",
        }}
      >
        {command ? (
          <>
            {installLine && (
              <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{installLine}</span>
            )}
            {loginLine && (
              <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{loginLine}</span>
            )}
          </>
        ) : (
          "Generating command…"
        )}
      </div>
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
  fill = false,
}: {
  repos: readonly GithubRepo[];
  selected: readonly string[];
  onToggle: (cloneUrl: string) => void;
  /** Flex to fill the space left in the step (scrolls internally) instead of a fixed cap. */
  fill?: boolean;
}) {
  return (
    <div
      className="flex flex-col"
      style={{
        gap: "var(--sp-1)",
        overflowY: "auto",
        padding: "var(--sp-1)",
        border: "var(--hairline) solid var(--border-faint)",
        borderRadius: "var(--radius-input)",
        // flexShrink 0 makes the height deterministic: always min(content, cap),
        // never shrunk by the surrounding flex chain. Without it the picker has
        // three competing constraints (its cap, flex-shrink, and main's
        // maxHeight) the browser resolves over several layout passes — which
        // shows up as a brief overflow/scrollbar before it settles.
        flexShrink: 0,
        // `fill`: a generous viewport-relative cap — the list takes most of the
        // height the step leaves and scrolls internally, so a long repo list
        // never pushes the page into a scrollbar. The 33rem subtracts the shell
        // chrome: header + the body's 6rem top-anchor + bottom padding + the
        // step's non-picker content. (Keep in sync with the shell's paddingTop.)
        // Resolves on first paint (no flex-height reflow), so no transient
        // overflow. Otherwise a sane fixed cap.
        ...(fill ? { maxHeight: "min(40rem, calc(100vh - 33rem))" } : { maxHeight: "min(16rem, 40vh)" }),
      }}
    >
      {repos.map((repo) => {
        const active = selected.includes(repo.cloneUrl);
        // Split owner/name so the repeated owner prefix recedes and the
        // distinguishing repo name carries the weight.
        const slash = repo.fullName.lastIndexOf("/");
        const repoOwner = slash >= 0 ? repo.fullName.slice(0, slash + 1) : "";
        const repoName = slash >= 0 ? repo.fullName.slice(slash + 1) : repo.fullName;
        return (
          <label
            key={repo.cloneUrl}
            className="onboarding-choice flex items-center text-body"
            style={{
              // position:relative makes this row the containing block for the
              // sr-only checkbox below. Without it, the absolutely-positioned
              // checkbox is laid out against the nearest *transformed* ancestor
              // (the fade-in step wrapper), escaping the picker's overflow clip —
              // all the rows' checkboxes stack far past the viewport and force
              // the whole page to scroll.
              position: "relative",
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
              {repoOwner && <span style={{ color: "var(--fg-4)" }}>{repoOwner}</span>}
              <span style={{ color: active ? "var(--fg)" : "var(--fg-2)" }}>{repoName}</span>
            </span>
            {repo.private && <Lock className="h-3.5 w-3.5" style={{ color: "var(--fg-4)", flexShrink: 0 }} />}
            <a
              href={repo.htmlUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="repo-open"
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
