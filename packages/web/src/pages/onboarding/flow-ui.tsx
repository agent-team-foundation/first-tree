import { Check, CircleAlert, Copy, ExternalLink, Info, Lock, Search, X } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import type { GithubRepo } from "../../api/github.js";
import { Button } from "../../components/ui/button.js";
import { useCopyFeedback } from "../../lib/use-copy-feedback.js";
import { cn } from "../../lib/utils.js";

/**
 * Step heading (title + optional one-line "why"). Used when a step renders its
 * own heading per sub-state instead of the shell's static one — the shell
 * skips title/why when STEP_COPY leaves them empty. Spacing matches the shell's
 * heading so per-state steps line up with static ones.
 */
export function StepHeading({ title, why }: { title: string; why?: ReactNode }) {
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-2_5)" }}>
      {/* Skip the h1 on an empty title so state-specific copy can omit a heading. */}
      {title ? (
        <h1 className="text-title font-semibold" style={{ margin: 0, color: "var(--fg)" }}>
          {title}
        </h1>
      ) : null}
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
 * Light inline note — a quiet icon + line, NOT a filled callout box. This is
 * the onboarding default for passive status / problem / info messages
 * (recoverable errors, "still missing X", troubleshooting hints). The filled
 * `<FlowNote>` is reserved for interactive panels that genuinely need
 * containment (e.g. a confirm-with-consequences).
 *
 * The text stays muted and there's no box/background — keeping it light. Only
 * the `error` glyph carries a restrained error color (`--fg-error-strong`, not
 * a neon red) so a failure still reads AS a failure at a glance for sighted
 * users, not just via `role="alert"`. `info` keeps the neutral muted glyph.
 */
export function FlowHint({
  children,
  tone = "info",
  role,
}: {
  children: ReactNode;
  tone?: "error" | "info";
  role?: "status" | "alert";
}) {
  const Icon = tone === "error" ? CircleAlert : Info;
  return (
    <p
      className="flex items-start text-label"
      role={role}
      style={{ gap: "var(--sp-1_5)", margin: 0, color: "var(--fg-3)" }}
    >
      {/* Box the icon to the text's line-height and center it, so the glyph
          lines up with the FIRST line of the hint — keeps single- AND
          multi-line hints aligned (a fixed marginTop only worked for one). */}
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          height: "calc(var(--text-label) * var(--text-label--line-height))",
          flexShrink: 0,
        }}
      >
        <Icon
          className="h-3.5 w-3.5"
          style={{ color: tone === "error" ? "var(--fg-error-strong)" : "var(--fg-4)" }}
          aria-hidden="true"
        />
      </span>
      <span style={{ minWidth: 0 }}>{children}</span>
    </p>
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
 * The terminal command(s) the user pastes to connect a computer. Renders
 * whatever lines the server's bootstrap command contains — hosted channels
 * currently return a readable installer pipeline followed by an independent
 * `~/.local/bin/<binName> login <code>` command, while dev returns only its
 * source-installed login command. The hosted lines intentionally have no
 * shell-level transaction or failure guard between them. Each line nowraps
 * and ellipsizes on overflow so a long opaque token shows as much as fits
 * without word-breaking; Copy puts the full multi-line command on the
 * clipboard regardless of what's visible.
 *
 * The previous implementation pattern-matched lines by command prefix, which
 * was fragile: adding a new command or environment assignment could silently
 * drop content from the visible box while Copy still worked. The current
 * pass-through trusts the server and renders the lines it gave us, in order.
 */
export function CommandBox({
  command,
  placeholder = "Generating command…",
}: {
  command: string | null;
  /** Shown when `command` is null (e.g. "Generating command…" or "…"). */
  placeholder?: string;
}) {
  // Shared copy → transient-feedback machine (success label only here).
  const { status: copyStatus, copy } = useCopyFeedback();
  const copied = copyStatus === "copied";
  const lines = command ? command.split("\n").filter((l) => l.trim().length > 0) : [];

  const handleCopy = (): void => {
    if (!command) return;
    void copy(command);
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
function SelectableRow({
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
            {repo.private && (
              // Wrapped so the padlock has a hover tooltip + accessible label —
              // bare, it reads ambiguously (a new user can misread it as
              // "locked / can't pick" rather than "this repo is private").
              <span
                role="img"
                title="Private repository"
                aria-label="Private repository"
                style={{ display: "inline-flex", flexShrink: 0 }}
              >
                <Lock className="h-3.5 w-3.5" style={{ color: "var(--fg-4)" }} />
              </span>
            )}
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

function shortRepoName(fullName: string): string {
  const i = fullName.lastIndexOf("/");
  return i >= 0 ? fullName.slice(i + 1) : fullName;
}

/**
 * Token/combobox repo picker (onboarding): selected repos render as removable
 * chips INSIDE the search field; typing filters the list below (which never
 * hides the chips). Multi-select, default none. Identity key is `cloneUrl`.
 */
export function RepoTokenPicker({
  repos,
  selected,
  onToggle,
  onClear,
}: {
  repos: readonly GithubRepo[];
  selected: readonly string[];
  onToggle: (cloneUrl: string) => void;
  onClear: () => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? repos.filter((r) => r.fullName.toLowerCase().includes(q)) : repos;
  }, [repos, query]);
  const selectedRepos = repos.filter((r) => selected.includes(r.cloneUrl));

  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-2_5)" }}>
      {/* Token field — chips inside + a grow search input. */}
      <div
        className="flex items-center flex-wrap"
        style={{
          gap: "var(--sp-2)",
          padding: "var(--sp-1_5) var(--sp-2_5)",
          borderRadius: "var(--radius-input)",
          border: "var(--hairline) solid var(--border)",
          background: "var(--bg)",
        }}
      >
        <Search className="h-4 w-4" style={{ color: "var(--fg-4)", flexShrink: 0 }} aria-hidden="true" />
        {selectedRepos.map((r) => (
          <span
            key={r.cloneUrl}
            className="inline-flex items-center text-caption font-medium"
            style={{
              gap: "var(--sp-1)",
              padding: "var(--sp-0_5) var(--sp-1) var(--sp-0_5) var(--sp-2)",
              borderRadius: "var(--radius-chip)",
              background: "var(--brand-bg)",
              color: "var(--brand-dim)",
              whiteSpace: "nowrap",
            }}
          >
            {shortRepoName(r.fullName)}
            <button
              type="button"
              onClick={() => onToggle(r.cloneUrl)}
              aria-label={`Remove ${r.fullName}`}
              className="inline-flex items-center justify-center"
              style={{
                width: "var(--sp-3_5)",
                height: "var(--sp-3_5)",
                borderRadius: "var(--radius-full)",
                border: 0,
                background: "transparent",
                color: "var(--brand-dim)",
                cursor: "pointer",
              }}
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          </span>
        ))}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={selected.length > 0 ? "Add repos…" : "Search repos…"}
          aria-label="Search repos"
          className="text-body"
          style={{
            flex: 1,
            minWidth: "8rem",
            border: 0,
            outline: "none",
            background: "transparent",
            color: "var(--fg)",
          }}
        />
      </div>

      {selected.length > 0 && (
        <div className="flex items-center justify-between" style={{ gap: "var(--sp-2)" }}>
          <span className="text-caption" style={{ color: "var(--fg-4)" }}>
            {selected.length} selected
          </span>
          <button
            type="button"
            onClick={onClear}
            className="text-caption font-medium"
            style={{ border: 0, background: "transparent", color: "var(--primary)", cursor: "pointer" }}
          >
            Clear all
          </button>
        </div>
      )}

      <div
        className="flex flex-col"
        style={{
          gap: "var(--sp-0_5)",
          overflowY: "auto",
          padding: "var(--sp-1)",
          borderRadius: "var(--radius-input)",
          border: "var(--hairline) solid var(--border-faint)",
          maxHeight: "min(40rem, calc(100vh - 33rem))",
          flexShrink: 0,
        }}
      >
        {filtered.length === 0 ? (
          <p className="text-label" style={{ margin: 0, padding: "var(--sp-3) var(--sp-2_5)", color: "var(--fg-4)" }}>
            No repos match “{query}”.
          </p>
        ) : (
          filtered.map((repo) => {
            const active = selected.includes(repo.cloneUrl);
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
                {repo.private && (
                  <span
                    role="img"
                    title="Private repository"
                    aria-label="Private repository"
                    style={{ display: "inline-flex", flexShrink: 0 }}
                  >
                    <Lock className="h-3.5 w-3.5" style={{ color: "var(--fg-4)" }} />
                  </span>
                )}
              </SelectableRow>
            );
          })
        )}
      </div>
    </div>
  );
}
