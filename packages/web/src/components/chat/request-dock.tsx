/**
 * RequestDock — the live open question pinned directly above the composer.
 *
 * The `format="request"` message in the timeline carries the long narrative
 * body; this dock carries ONLY the structured ask (questions + options) so the
 * thing awaiting the viewer's action stays attached to where they act: the
 * composer. Two decoupled answer channels, one send:
 *
 *   - clicking an option sets a SELECTION (kept as chat-view state, keyed by
 *     prompt) and only highlights the pill — it does NOT write into the
 *     composer, so a click never disturbs free text the viewer is typing;
 *   - the composer holds free text only (a free-text question's answer, or an
 *     extra note);
 *   - sending merges both channels and ALWAYS resolves via `metadata.resolves`
 *     (`kind="answered"`) — picking an option OR typing free text both resolve
 *     the question; there is no "leave it open for the asker to judge" path
 *     here. The asker is the default recipient, so it works without a typed
 *     @mention even in a group chat.
 *
 * The dock pins the OLDEST (FIFO) live request directed at the viewer (see
 * `findBlockingRequest`); the timeline hides every item after it and that
 * request's card suppresses its inline answer block, so the answering surface
 * exists exactly once.
 *
 * Design (DESIGN.md): the dock is interactive, so it keeps card chrome
 * (pillar 5) with the needs-you amber tint the inline answer block already
 * uses; options reuse `OptionCard` (neutral dot + tint selection — §7); the
 * helper line states what send will do, in mono caption like the rest of the
 * composer chrome.
 */
import type { OpenQuestionRequest } from "@first-tree/shared";
import { ArrowUpRight, MessageCircleQuestion } from "lucide-react";
import { OptionCard } from "../ui/option-card.js";
import { QuestionPrompt } from "./question-prompt.js";

export function RequestDock({
  requestId,
  payload,
  selections,
  directResolve,
  onPick,
  onJumpToOrigin,
}: {
  requestId: string;
  payload: OpenQuestionRequest;
  /** Option selections keyed by prompt — chat-view state, not draft-derived. */
  selections: Record<string, string>;
  /** Whether sending right now resolves (every required question answered). */
  directResolve: boolean;
  /**
   * Composer-empty / asker-name hints the dock no longer renders, kept on the
   * props so existing call sites (chat-view, the preview page, DOM tests) pass
   * them harmlessly; the helper line is now a single always-resolve message.
   */
  draftEmpty?: boolean;
  askerName?: string;
  onPick: (prompt: string, option: string) => void;
  /**
   * Scroll the timeline to the request's own card — the dock carries only the
   * structured ask, so this is the way back to the full markdown context.
   * Omitted (e.g. in the preview page) the affordance is hidden.
   */
  onJumpToOrigin?: () => void;
}) {
  const questionCount = payload.questions.length;
  const subject = payload.subject ?? "Request";
  const hasFree = payload.questions.some((q) => q.kind === "free");

  return (
    <div
      style={{
        marginBottom: "var(--sp-1_5)",
        border: "var(--hairline) solid var(--border)",
        borderRadius: "var(--radius-panel)",
        background: "color-mix(in oklch, var(--state-needs-you) 4%, var(--bg-raised))",
        padding: "var(--sp-2_5) var(--sp-3)",
        // The dock lives in the `shrink-0` composer footer, which has no scroll
        // of its own. A long ask — many questions, or a legacy wall-of-text
        // prompt the user expanded via "Show all" — would otherwise grow the
        // dock past the viewport and push its own option list AND the composer
        // off-screen with no way to reach them. Cap the height and scroll the
        // dock internally so the options stay reachable and the composer below
        // stays visible.
        maxHeight: "min(40vh, 32rem)",
        overflowY: "auto",
      }}
    >
      <div
        className="mono text-caption font-semibold"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--sp-1)",
          color: "var(--fg-needs-you-strong)",
          textTransform: "uppercase",
          marginBottom: "var(--sp-2)",
        }}
      >
        <MessageCircleQuestion size={12} className="shrink-0" />
        {`Awaiting your answer · ${subject} · ${questionCount} question${questionCount === 1 ? "" : "s"}`}
        {onJumpToOrigin ? (
          <button
            type="button"
            onClick={onJumpToOrigin}
            className="mono text-caption rounded-[var(--radius-input)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
            style={{
              marginLeft: "auto",
              display: "inline-flex",
              alignItems: "center",
              gap: "var(--sp-0_5)",
              background: "none",
              border: "none",
              padding: 0,
              textTransform: "none",
              letterSpacing: "normal",
              fontWeight: 500,
              color: "var(--fg-needs-you-strong)",
              cursor: "pointer",
            }}
          >
            View context
            <ArrowUpRight size={11} className="shrink-0" />
          </button>
        ) : null}
      </div>

      {payload.questions.map((q, i) => (
        <div key={q.id} style={{ marginTop: i === 0 ? 0 : "var(--sp-3)" }}>
          <div style={{ display: "flex", gap: "var(--sp-1_5)", alignItems: "baseline" }}>
            <span className="mono text-caption shrink-0" style={{ color: "var(--fg-4)" }}>
              {`Q${i + 1}`}
            </span>
            <div className="text-body font-medium" style={{ color: "var(--fg)", flex: 1, minWidth: 0 }}>
              <QuestionPrompt prompt={q.prompt} />
            </div>
          </div>
          {q.kind === "single" ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-1_5)", marginTop: "var(--sp-1_5)" }}>
              {q.options.map((opt) => (
                <OptionCard
                  key={opt}
                  layout="pill"
                  // Namespace by message id — question ids are request-local
                  // (`q1`, …) and the suppressed timeline card may still render
                  // for other viewers; a distinct group keeps DOM radio state
                  // from crossing surfaces.
                  name={`dock:${requestId}:${q.id}`}
                  checked={selections[q.prompt] === opt}
                  onSelect={() => onPick(q.prompt, opt)}
                >
                  <span className="text-body">{opt}</span>
                </OptionCard>
              ))}
            </div>
          ) : (
            <div className="mono text-caption" style={{ color: "var(--fg-4)", marginTop: "var(--sp-1)" }}>
              (free-text — type your answer in the composer below)
            </div>
          )}
        </div>
      ))}

      {payload.allowExtra && !hasFree ? (
        <div className="mono text-caption" style={{ color: "var(--fg-4)", marginTop: "var(--sp-2)" }}>
          (you can add a note in the composer below — it's sent with your answer)
        </div>
      ) : null}

      <div
        className="mono text-caption"
        style={{
          marginTop: "var(--sp-2_5)",
          paddingTop: "var(--sp-2)",
          borderTop: "var(--hairline) solid var(--border-faint)",
          color: "var(--fg-3)",
        }}
      >
        {directResolve
          ? "↵ Send answers and resolves this question"
          : "Pick an option or type your answer — sending resolves this question"}
      </div>
    </div>
  );
}
