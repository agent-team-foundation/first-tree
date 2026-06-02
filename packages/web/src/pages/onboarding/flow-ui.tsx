import { Check, CircleAlert, Copy, ExternalLink, Info, Lock } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import type { GithubRepo } from "../../api/github.js";
import { Button } from "../../components/ui/button.js";
import { cn } from "../../lib/utils.js";

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

/**
 * Inline notice. Tone "error" (red) or "info" (blue). Both render through the
 * design-system callout token pairs (DESIGN.md §3) — a soft background plus a
 * strong text/border tone — the same `border-{tone} bg-{tone}-soft text-{tone}`
 * grammar as the rest of the app's notices, rather than hand-mixing colors.
 */
export function FlowNote({ children, tone = "error" }: { children: ReactNode; tone?: "error" | "info" }) {
  const Icon = tone === "error" ? CircleAlert : Info;
  return (
    <div
      className={cn(
        "flex items-start text-label rounded-[var(--radius-input)] border",
        tone === "error" ? "border-error bg-error-soft text-error" : "border-info bg-info-soft text-info",
      )}
      role={tone === "error" ? "alert" : undefined}
      style={{ gap: "var(--sp-2)", padding: "var(--sp-2_5) var(--sp-3)" }}
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
              borderRadius: "var(--radius-full)",
              background: "var(--state-working)",
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
        color: state === "ok" ? "var(--success)" : "var(--fg-3)",
      }}
    >
      {state === "ok" ? (
        <Check className="h-3.5 w-3.5" />
      ) : (
        <span
          aria-hidden="true"
          style={{ position: "relative", display: "inline-block", width: "var(--sp-2)", height: "var(--sp-2)" }}
        >
          <span
            style={{
              position: "absolute",
              inset: 0,
              borderRadius: "var(--radius-full)",
              background: "var(--state-working)",
            }}
          />
          <span
            style={{
              position: "absolute",
              inset: "calc(-1 * var(--sp-0_75))",
              borderRadius: "var(--radius-full)",
              border: "var(--hairline) solid var(--state-working)",
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
 * The terminal one-liner(s) the user pastes to connect a computer. Renders
 * whatever lines the server's bootstrap command contains — typically two
 * (`npm install -g …` then `first-tree login <token>`), but dev channels
 * return only the login line, and a future channel might add more. Each
 * line nowraps and ellipsizes on overflow so a long opaque token shows as
 * much as fits without word-breaking; Copy puts the full multi-line command
 * on the clipboard regardless of what's visible.
 *
 * The previous implementation pattern-matched lines by prefix
 * (`startsWith("npm")` / `startsWith("first-tree")`), which was fragile —
 * adding a new prefix (yarn / pnpm / `cd …`) would silently drop content
 * from the visible box while Copy still worked. The current pass-through
 * trusts the server: render the lines it gave us, in order.
 */
export function CommandBox({
  command,
  placeholder = "Generating command…",
}: {
  command: string | null;
  /** Shown when `command` is null (e.g. "Generating command…" or "…"). */
  placeholder?: string;
}) {
  const [copied, setCopied] = useState(false);
  const lines = command ? command.split("\n").filter((l) => l.trim().length > 0) : [];

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
          minHeight: "var(--sp-10)",
          margin: 0,
          padding: "var(--sp-2_5) var(--sp-3)",
          background: "color-mix(in oklch, var(--bg-sunken) 42%, transparent)",
          border: "var(--hairline) solid color-mix(in oklch, var(--border-faint) 58%, transparent)",
          borderRadius: "var(--radius-input)",
          color: "var(--fg-2)",
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          gap: "var(--sp-0_5)",
        }}
      >
        {command ? (
          lines.map((line, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional and stable per render
              key={i}
              style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
            >
              {line}
            </span>
          ))
        ) : (
          <span>{placeholder}</span>
        )}
      </div>
      <Button type="button" variant="outline" onClick={handleCopy} disabled={!command} className="h-auto">
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

/**
 * One selectable checkbox row, shared by the repo picker and the invitee's
 * project-confirm list so both read identically. The real `<input>` is
 * `sr-only` (focus ring comes from `.onboarding-choice:focus-within` in
 * index.css, per DESIGN.md §13); selection is signalled the OptionCard way —
 * a filled neutral box plus a very light `--fg` tint (~5%), no colored row
 * border. `position: relative` makes the row the containing block for the
 * absolutely-positioned sr-only input, so it can't escape the picker's clip.
 */
export function SelectableRow({
  checked,
  onToggle,
  children,
}: {
  checked: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <label
      className="onboarding-choice flex items-center text-body"
      style={{
        position: "relative",
        gap: "var(--sp-2_5)",
        padding: "var(--sp-2) var(--sp-2_5)",
        borderRadius: "var(--radius-input)",
        cursor: "pointer",
        background: checked ? "color-mix(in oklch, var(--fg) 5%, transparent)" : "transparent",
        color: checked ? "var(--fg)" : "var(--fg-2)",
      }}
    >
      <input type="checkbox" checked={checked} onChange={onToggle} className="sr-only" />
      <span
        aria-hidden="true"
        className="inline-flex items-center justify-center"
        style={{
          width: "var(--sp-4)",
          height: "var(--sp-4)",
          flexShrink: 0,
          borderRadius: "var(--radius-input)",
          border: checked ? "var(--hairline) solid var(--primary)" : "var(--hairline) solid var(--border-strong)",
          background: checked ? "var(--primary)" : "transparent",
          color: "var(--primary-on)",
        }}
      >
        {checked && <Check className="h-3 w-3" />}
      </span>
      {children}
    </label>
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
          <SelectableRow key={repo.cloneUrl} checked={active} onToggle={() => onToggle(repo.cloneUrl)}>
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
          </SelectableRow>
        );
      })}
    </div>
  );
}
