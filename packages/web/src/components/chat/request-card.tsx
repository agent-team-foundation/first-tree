/**
 * RequestCard — renders a `format="request"` message: an "open question"
 * directed at one human. Owns the whole rendering (header chip + long
 * markdown body + interactive answer block) plus its collapse/expand state,
 * because collapsing must hide body AND answer block together.
 *
 * Lifecycle (open / discussing / resolved / closed) is derived from the
 * thread, not stored (see request-state.ts). The answer block is interactive
 * only for the target while the request is unresolved (`open` or `discussing`);
 * everyone else sees it read-only, and unrelated viewers get it collapsed by
 * default. A clean answer sends a reply that threads under the request
 * (`inReplyTo`) AND carries the explicit `metadata.resolves` signal the
 * server's −1 / red-dot clear keys off — a plain "chat about this" reply omits
 * `resolves` and leaves the question open. See proposals/group-chat-unified-send §D1.
 *
 * Design (DESIGN.md): `open` keeps card chrome because it is *interactive*
 * (pillar 5). `resolved` / `closed` are read-only and render as plain labeled
 * content — no filled/bordered card. Actions reuse the `Button` primitive
 * (neutral, never green — pillar 2); single-select options reuse `OptionCard`
 * (neutral dot + tint selection, never a colored border — §7); chips and
 * affordances use lucide icons, never custom glyphs (§8).
 */
import type { Message, OpenQuestionItem } from "@first-tree/shared";
import { useMutation } from "@tanstack/react-query";
import { ArrowRight, Ban, ChevronRight, CircleCheck, MessageCircleQuestion } from "lucide-react";
import { type ComponentType, type KeyboardEvent, type ReactNode, useMemo, useState } from "react";
import { sendChatMessage } from "../../api/chats.js";
import { Button } from "../ui/button.js";
import { OptionCard } from "../ui/option-card.js";
import {
  defaultExpanded,
  deriveRequestState,
  isRelatedViewer,
  parseAnswerSelections,
  type RequestState,
  readCloseReason,
  readMentions,
  readRequestPayload,
} from "./request-state.js";

type ChipSpec = { label: string; Icon: ComponentType<{ size?: number }>; bg: string; fg: string };

const CHIP: Record<RequestState, ChipSpec> = {
  // amber needs-you — the open question's "your action needed" lifecycle state.
  open: {
    label: "REQUEST",
    Icon: MessageCircleQuestion,
    bg: "var(--state-needs-you-soft)",
    fg: "var(--fg-needs-you-strong)",
  },
  // amber needs-you — a "chat about this" exchange is in flight but the
  // question is not answered yet, so it still needs the human's action.
  discussing: {
    label: "DISCUSSING",
    Icon: MessageCircleQuestion,
    bg: "var(--state-needs-you-soft)",
    fg: "var(--fg-needs-you-strong)",
  },
  // success green — answered.
  resolved: { label: "RESOLVED", Icon: CircleCheck, bg: "var(--bg-success-soft)", fg: "var(--fg-success-strong)" },
  // neutral sunken — withdrawn by the asker.
  closed: { label: "CLOSED", Icon: Ban, bg: "var(--bg-sunken)", fg: "var(--fg-3)" },
};

function Chip({ state, target }: { state: RequestState; target?: string }) {
  const c = CHIP[state];
  return (
    <span
      className="mono text-caption font-semibold"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--sp-1)",
        padding: "var(--sp-px) var(--sp-1_5)",
        borderRadius: "var(--radius-chip)",
        background: c.bg,
        color: c.fg,
        whiteSpace: "nowrap",
      }}
    >
      <c.Icon size={11} />
      {c.label}
      {target ? ` · @${target}` : null}
    </span>
  );
}

export function RequestCard({
  message,
  thread,
  viewerAgentId,
  body,
  bodyShowsTarget = false,
  resolveAgentName,
  onSent,
}: {
  message: Message;
  thread: readonly Message[];
  viewerAgentId: string | null;
  /** Pre-rendered markdown body (the chat-view owns the Markdown setup). */
  body: ReactNode;
  /**
   * Whether the rendered body already shows the target as a mention chip
   * (chat-view computes this against the same membership projection rehype
   * uses). When true the expanded chip drops its `· @target` to avoid showing
   * the target twice; when false (web / non-normalised / historical writes
   * whose body has no `@target`) the chip keeps it as the target signal.
   */
  bodyShowsTarget?: boolean;
  resolveAgentName: (agentId: string) => string;
  /** Called after a successful answer send so the parent can refresh. */
  onSent?: () => void;
}) {
  const state = useMemo(() => deriveRequestState(message, thread), [message, thread]);
  const payload = useMemo(() => readRequestPayload(message.metadata), [message.metadata]);
  const targets = useMemo(() => readMentions(message.metadata), [message.metadata]);
  const related = isRelatedViewer(message, viewerAgentId);
  const isTarget = viewerAgentId != null && targets.includes(viewerAgentId);
  // The card stays interactive while the question is unresolved — `open` or
  // `discussing` (a "chat about this" exchange doesn't lock the answer block).
  const answerable = state === "open" || state === "discussing";
  const canAnswer = answerable && isTarget;

  const targetLabel = targets[0] ? resolveAgentName(targets[0]) : undefined;
  const subject = payload?.subject ?? "Request";
  const questionCount = payload?.questions.length ?? 0;

  const [expanded, setExpanded] = useState(() => defaultExpanded(state, related));
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [free, setFree] = useState<Record<string, string>>({});

  // For a resolved request, recover the chosen answers from the resolving
  // message so the card can echo them (keyed by prompt). The resolving message
  // is the one carrying `metadata.resolves` (kind="answered") for this request;
  // its body holds the `"prompt → answer"` lines. Empty when the answer was a
  // free-form reply that doesn't match the format.
  const selections = useMemo<Record<string, string>>(() => {
    if (state !== "resolved" || !payload) return {};
    const reply = thread.find((m) => {
      const raw = m.metadata?.resolves;
      return (
        raw != null &&
        typeof raw === "object" &&
        (raw as { request?: unknown }).request === message.id &&
        (raw as { kind?: unknown }).kind === "answered"
      );
    });
    return reply
      ? parseAnswerSelections(
          reply.content,
          payload.questions.map((q) => q.prompt),
        )
      : {};
  }, [state, payload, thread, message.id]);

  const mut = useMutation({
    // A clean answer from the target resolves the question: it threads under
    // the request (`inReplyTo`) AND carries the explicit `resolves` signal that
    // drives the server's red-dot −1. (A plain "chat about this" reply, sent
    // from the composer, omits `resolves` and only threads.)
    mutationFn: (content: string) =>
      sendChatMessage(message.chatId, content, [message.senderId], {
        inReplyTo: message.id,
        resolves: { request: message.id, kind: "answered" },
      }),
    onSuccess: () => onSent?.(),
  });

  const answerFor = (q: OpenQuestionItem): string =>
    q.kind === "single" ? (choices[q.id] ?? "") : (free[q.id] ?? "").trim();
  const allRequiredAnswered = (payload?.questions ?? []).every((q) => !q.required || answerFor(q).length > 0);

  function submit() {
    if (!payload || !allRequiredAnswered || mut.isPending) return;
    const lines = payload.questions.map((q) => `${q.prompt} → ${answerFor(q) || "—"}`);
    mut.mutate(lines.join("\n"));
  }

  function onKeyDown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  }

  // Closing is explicit now (the asker calls `chat send --close`; re-asking never
  // auto-supersedes) — show the reason they gave, when any.
  const closeReason = state === "closed" ? readCloseReason(message, thread) : null;
  const summary =
    state === "resolved"
      ? "answered"
      : state === "closed"
        ? "withdrawn"
        : state === "discussing"
          ? "discussing"
          : `${questionCount} question${questionCount === 1 ? "" : "s"}`;

  // ── Collapsed: one row, body + answer block hidden. Click anywhere to expand.
  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="text-body"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--sp-1_5)",
          flexWrap: "wrap",
          marginTop: "var(--sp-1)",
          background: "none",
          border: "none",
          padding: 0,
          textAlign: "left",
          cursor: "pointer",
          width: "100%",
        }}
      >
        <ChevronRight size={13} className="shrink-0" style={{ color: "var(--fg-4)" }} />
        <Chip state={state} />
        <span className="font-semibold" style={{ color: state === "open" ? "var(--fg-2)" : "var(--fg-3)" }}>
          {subject}
        </span>
        <span className="mono text-caption" style={{ color: "var(--fg-4)" }}>
          {targetLabel ? `· @${targetLabel} ` : ""}· {summary}
        </span>
      </button>
    );
  }

  // ── Expanded
  return (
    <div style={{ marginTop: "var(--sp-1)" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: "var(--sp-2)", flexWrap: "wrap" }}>
        {/* Drop the chip's `· @target` only when the body already shows the
            target mention (server-normalised content), to avoid showing it
            twice. Otherwise keep it as the target signal. */}
        <Chip state={state} target={bodyShowsTarget ? undefined : targetLabel} />
        <span
          className="text-subtitle font-semibold"
          style={{ color: state === "closed" ? "var(--fg-3)" : "var(--fg)" }}
        >
          {subject}
        </span>
        {canAnswer ? (
          <span className="mono text-caption" style={{ marginLeft: "auto", color: "var(--fg-4)" }}>
            awaiting your answer
          </span>
        ) : null}
        {/* Collapse is available to anyone who can expand — gating it on
            `related` stranded unrelated viewers expanded with no way back. */}
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="mono text-caption"
          style={{
            marginLeft: canAnswer ? "var(--sp-2)" : "auto",
            background: "none",
            border: "none",
            color: "var(--fg-4)",
            cursor: "pointer",
          }}
        >
          Collapse
        </button>
      </div>

      {/* long markdown body */}
      <div style={{ marginTop: "var(--sp-1_5)" }}>{body}</div>

      {/* state-specific block: `open` keeps interactive card chrome; `resolved`
          / `closed` are read-only and render as plain labeled content — no
          filled/bordered card (DESIGN.md pillar 5). */}
      {answerable && payload ? (
        <div
          style={{
            marginTop: "var(--sp-3)",
            border: "var(--hairline) solid var(--border)",
            borderRadius: "var(--radius-panel)",
            background: "color-mix(in oklch, var(--state-needs-you) 4%, var(--bg-raised))",
            padding: "var(--sp-2_5) var(--sp-3)",
          }}
        >
          <div
            className="mono text-caption font-semibold"
            style={{ color: "var(--fg-needs-you-strong)", textTransform: "uppercase", marginBottom: "var(--sp-2)" }}
          >
            {canAnswer
              ? `Your answer · ${questionCount} question${questionCount === 1 ? "" : "s"}`
              : `Questions · ${questionCount}`}
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
                      // Namespace the radio group by message id: question ids
                      // are only request-local (`q1`, …), so two open requests
                      // in one chat would otherwise share a real radio group and
                      // selecting in one card would clear the other's DOM state.
                      name={`${message.id}:${q.id}`}
                      checked={choices[q.id] === opt}
                      disabled={!canAnswer}
                      onSelect={() => setChoices((prev) => ({ ...prev, [q.id]: opt }))}
                    >
                      <span className="text-body">{opt}</span>
                    </OptionCard>
                  ))}
                </div>
              ) : canAnswer ? (
                <textarea
                  value={free[q.id] ?? ""}
                  onChange={(e) => setFree((prev) => ({ ...prev, [q.id]: e.target.value }))}
                  onKeyDown={onKeyDown}
                  placeholder="Type your answer…"
                  className="text-body"
                  style={{
                    width: "100%",
                    marginTop: "var(--sp-1_5)",
                    border: "var(--hairline) solid var(--border-strong)",
                    borderRadius: "var(--radius-input)",
                    background: "var(--bg-raised)",
                    padding: "var(--sp-1_5) var(--sp-2)",
                    color: "var(--fg)",
                    minHeight: "var(--sp-10)",
                    resize: "vertical",
                  }}
                />
              ) : (
                <div className="text-caption mono" style={{ color: "var(--fg-4)", marginTop: "var(--sp-1)" }}>
                  (free-text answer)
                </div>
              )}
            </div>
          ))}

          {canAnswer ? (
            <div
              style={{
                marginTop: "var(--sp-3)",
                display: "flex",
                alignItems: "center",
                gap: "var(--sp-2_5)",
                borderTop: "var(--hairline) solid var(--border-faint)",
                paddingTop: "var(--sp-2_5)",
              }}
            >
              <Button
                type="button"
                size="sm"
                onClick={submit}
                onKeyDown={onKeyDown}
                disabled={!allRequiredAnswered || mut.isPending}
              >
                {mut.isPending ? "Sending…" : "Reply"}
              </Button>
              <span className="mono text-caption" style={{ color: "var(--fg-4)" }}>
                Selections are staged — Reply to send (⌘↵)
              </span>
            </div>
          ) : null}

          {mut.isError ? (
            <div className="text-caption mono" style={{ color: "var(--state-error)", marginTop: "var(--sp-1_5)" }}>
              Failed to send — try again.
            </div>
          ) : null}
        </div>
      ) : null}

      {/* resolved — read-only echo of the chosen answers, no card chrome */}
      {state === "resolved" && payload ? (
        <div
          style={{
            marginTop: "var(--sp-2)",
            paddingTop: "var(--sp-2)",
            borderTop: "var(--hairline) solid var(--border-faint)",
          }}
        >
          {payload.questions.map((q, i) => (
            <div
              key={q.id}
              className="text-body"
              style={{
                display: "flex",
                alignItems: "baseline",
                flexWrap: "wrap",
                gap: "var(--sp-2)",
                marginTop: i === 0 ? 0 : "var(--sp-1)",
              }}
            >
              <span className="mono text-caption" style={{ color: "var(--fg-4)" }}>{`Q${i + 1}`}</span>
              <span style={{ color: "var(--fg-3)" }}>{q.prompt}</span>
              <ArrowRight size={13} className="shrink-0 self-center" style={{ color: "var(--fg-4)" }} />
              <span className="font-medium" style={{ color: "var(--fg)" }}>
                {selections[q.prompt] ?? "answered"}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {/* closed — read-only one-line status, no card chrome */}
      {state === "closed" ? (
        <div className="text-body" style={{ marginTop: "var(--sp-1_5)", color: "var(--fg-3)" }}>
          {closeReason ? `Withdrawn — ${closeReason}` : "Withdrawn by the asker."}
          {questionCount > 0 ? (
            <span style={{ color: "var(--fg-4)" }}>
              {` · ${questionCount} question${questionCount === 1 ? "" : "s"} unanswered`}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
