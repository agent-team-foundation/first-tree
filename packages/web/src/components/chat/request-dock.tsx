/**
 * RequestDock — the live open question pinned directly above the composer.
 *
 * The `format="request"` message in the timeline carries the long narrative
 * body; this dock carries ONLY the structured ask (questions + options) so the
 * thing awaiting the viewer's action stays attached to where they act: the
 * input box. One send button, one box, one rule:
 *
 *   - clicking an option REPLACES the composer draft with the canonical
 *     answer text (single question → the option itself; several → one
 *     `"<prompt> → <answer>"` line each);
 *   - the selection state is DERIVED from the draft (`recoverAnswerSelections`
 *     in chat-view), so editing the text away from a clean answer drops the
 *     highlight — and typing the exact option text by hand counts as a clean
 *     answer (accepted semantics: the draft is the single source of truth);
 *   - sending a clean answer direct-resolves via `metadata.resolves`
 *     (`kind="answered"`) — instant red-dot clear;
 *   - sending any other text is a plain reply routed to the asking agent to
 *     judge (answer / discuss / close) — the question stays open. While the
 *     dock is live the asker is the default recipient, so this works without
 *     a typed @mention even in a group chat.
 *
 * The dock pins the single most recent live request directed at the viewer
 * (see `findDockableRequest`); that request's timeline card suppresses its
 * inline answer block so the answering surface exists exactly once.
 *
 * Design (DESIGN.md): the dock is interactive, so it keeps card chrome
 * (pillar 5) with the needs-you amber tint the inline answer block already
 * uses; options reuse `OptionCard` (neutral dot + tint selection — §7); the
 * helper line states what send will do, in mono caption like the rest of the
 * composer chrome.
 */
import type { OpenQuestionRequest } from "@first-tree/shared";
import { MessageCircleQuestion } from "lucide-react";
import { OptionCard } from "../ui/option-card.js";

export function RequestDock({
  requestId,
  payload,
  selections,
  directResolve,
  draftEmpty,
  askerName,
  onPick,
}: {
  requestId: string;
  payload: OpenQuestionRequest;
  /** Keyed by prompt — the shape `recoverAnswerSelections` derives from the draft. */
  selections: Record<string, string>;
  /** Whether sending right now direct-resolves (clean untouched answer). */
  directResolve: boolean;
  /** Whether the composer draft is empty (drives the neutral helper line). */
  draftEmpty: boolean;
  askerName: string;
  onPick: (prompt: string, option: string) => void;
}) {
  const questionCount = payload.questions.length;
  const subject = payload.subject ?? "Request";
  const hasFree = payload.questions.some((q) => q.kind === "free");
  const sendKind = directResolve ? "resolve" : draftEmpty ? "empty" : "judge";

  return (
    <div
      style={{
        marginBottom: "var(--sp-1_5)",
        border: "var(--hairline) solid var(--border)",
        borderRadius: "var(--radius-panel)",
        background: "color-mix(in oklch, var(--state-needs-you) 4%, var(--bg-raised))",
        padding: "var(--sp-2_5) var(--sp-3)",
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
      </div>

      {payload.questions.map((q, i) => (
        <div key={q.id} style={{ marginTop: i === 0 ? 0 : "var(--sp-3)" }}>
          <div className="text-body font-medium" style={{ color: "var(--fg)" }}>
            <span className="mono text-caption" style={{ color: "var(--fg-4)", marginRight: "var(--sp-1_5)" }}>
              {`Q${i + 1}`}
            </span>
            {q.prompt}
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
          (you can add a note — an edited reply goes to {askerName} to judge)
        </div>
      ) : null}

      <div
        className="mono text-caption"
        style={{
          marginTop: "var(--sp-2_5)",
          paddingTop: "var(--sp-2)",
          borderTop: "var(--hairline) solid var(--border-faint)",
          color:
            sendKind === "resolve"
              ? "var(--fg-success-strong)"
              : sendKind === "judge"
                ? "var(--fg-info-strong)"
                : "var(--fg-4)",
        }}
      >
        {sendKind === "resolve"
          ? "↵ Send answers and resolves this question"
          : sendKind === "judge"
            ? `↵ Send replies for ${askerName} to judge — the question stays open`
            : "Pick an option to fill the composer, or type to discuss"}
      </div>
    </div>
  );
}
