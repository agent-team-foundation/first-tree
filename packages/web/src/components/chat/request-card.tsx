/**
 * RequestCard — renders a `format="request"` message: an "open question"
 * directed at one human. Owns the whole rendering (header chip + long
 * markdown body + interactive answer block) plus its collapse/expand state,
 * because collapsing must hide body AND answer block together.
 *
 * Lifecycle (open / resolved / closed) is derived from the thread, not stored
 * (see request-state.ts). The answer block is interactive only for the target
 * while the request is `open`; everyone else sees it read-only, and unrelated
 * viewers get it collapsed by default. Answering sends a normal reply message
 * with `inReplyTo` pointing at the request (the server's −1 / red-dot clear
 * keys off exactly that) — no new endpoint. See proposals/group-chat-unified-send §D1.
 */
import type { Message, OpenQuestionItem } from "@first-tree/shared";
import { useMutation } from "@tanstack/react-query";
import { type KeyboardEvent, type ReactNode, useMemo, useState } from "react";
import { sendChatMessage } from "../../api/chats.js";
import {
  defaultExpanded,
  deriveRequestState,
  isRelatedViewer,
  isReplacedByNewRequest,
  parseAnswerSelections,
  readMentions,
  readRequestPayload,
} from "./request-state.js";

const CHIP = {
  open: {
    label: "REQUEST",
    glyph: "◆",
    bg: "var(--state-needs-you-soft)",
    fg: "var(--fg-needs-you-strong)",
    bd: "color-mix(in oklch, var(--state-needs-you) 30%, transparent)",
    left: "var(--state-needs-you)",
  },
  resolved: {
    label: "RESOLVED",
    glyph: "✓",
    bg: "var(--brand-bg)",
    fg: "var(--brand-dim)",
    bd: "var(--brand-ring)",
    left: "var(--brand)",
  },
  closed: {
    label: "CLOSED",
    glyph: "⊘",
    bg: "var(--bg-sunken)",
    fg: "var(--fg-3)",
    bd: "var(--border-strong)",
    left: "var(--border-strong)",
  },
} as const;

function Chip({ state, target }: { state: keyof typeof CHIP; target?: string }) {
  const c = CHIP[state];
  return (
    <span
      className="mono text-caption font-semibold"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "var(--sp-px) var(--sp-1_5)",
        borderRadius: "var(--radius-chip)",
        background: c.bg,
        border: `var(--hairline) solid ${c.bd}`,
        color: c.fg,
        whiteSpace: "nowrap",
      }}
    >
      {c.glyph} {c.label}
      {target ? ` · @${target}` : null}
    </span>
  );
}

export function RequestCard({
  message,
  thread,
  viewerAgentId,
  body,
  resolveAgentName,
  onSent,
}: {
  message: Message;
  thread: readonly Message[];
  viewerAgentId: string | null;
  /** Pre-rendered markdown body (the chat-view owns the Markdown setup). */
  body: ReactNode;
  resolveAgentName: (agentId: string) => string;
  /** Called after a successful answer send so the parent can refresh. */
  onSent?: () => void;
}) {
  const state = useMemo(() => deriveRequestState(message, thread), [message, thread]);
  const payload = useMemo(() => readRequestPayload(message.metadata), [message.metadata]);
  const targets = useMemo(() => readMentions(message.metadata), [message.metadata]);
  const related = isRelatedViewer(message, viewerAgentId);
  const isTarget = viewerAgentId != null && targets.includes(viewerAgentId);
  const canAnswer = state === "open" && isTarget;

  const targetLabel = targets[0] ? resolveAgentName(targets[0]) : undefined;
  const subject = payload?.subject ?? "Request";
  const questionCount = payload?.questions.length ?? 0;

  const [expanded, setExpanded] = useState(() => defaultExpanded(state, related));
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [free, setFree] = useState<Record<string, string>>({});

  // For a resolved request, recover the chosen answers from the resolving
  // reply so the card can highlight them (keyed by prompt). Empty when the
  // answer was a free-form composer reply that doesn't match the format.
  const selections = useMemo<Record<string, string>>(() => {
    if (state !== "resolved" || !payload) return {};
    const reply = thread.find((m) => m.inReplyTo === message.id && targets.includes(m.senderId));
    return reply
      ? parseAnswerSelections(
          reply.content,
          payload.questions.map((q) => q.prompt),
        )
      : {};
  }, [state, payload, thread, message.id, targets]);

  const mut = useMutation({
    mutationFn: (content: string) =>
      sendChatMessage(message.chatId, content, [message.senderId], { inReplyTo: message.id }),
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

  // A `closed` request is either superseded by a replacement question or
  // actively withdrawn by the asker — copy differs so a plain close doesn't
  // read as "superseded by an updated question" (QA).
  const superseded = state === "closed" && isReplacedByNewRequest(message, thread);
  const summary =
    state === "open"
      ? `${questionCount} question${questionCount === 1 ? "" : "s"}`
      : state === "resolved"
        ? "answered"
        : superseded
          ? "superseded"
          : "withdrawn";

  // ── Collapsed: one row, body + answer block hidden. Click anywhere to expand.
  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="text-body"
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 7,
          flexWrap: "wrap",
          marginTop: 4,
          background: "none",
          border: "none",
          padding: 0,
          textAlign: "left",
          cursor: "pointer",
          width: "100%",
        }}
      >
        <span style={{ color: "var(--fg-4)" }}>▸</span>
        <Chip state={state} />
        <span className="font-semibold" style={{ color: state === "open" ? "var(--fg-2)" : "var(--fg-3)" }}>
          {subject}
        </span>
        <span className="mono text-caption" style={{ color: "var(--fg-4)" }}>
          {targetLabel ? `· @${targetLabel} ` : ""}· {summary}
        </span>
        <span style={{ color: "var(--fg-4)" }}>· Expand</span>
      </button>
    );
  }

  // ── Expanded
  const c = CHIP[state];
  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <Chip state={state} target={targetLabel} />
        <span
          className="text-subtitle font-semibold"
          style={{ color: state === "closed" ? "var(--fg-3)" : "var(--fg)" }}
        >
          {subject}
        </span>
        {state === "open" && isTarget ? (
          <span className="mono text-caption" style={{ marginLeft: "auto", color: "var(--fg-4)" }}>
            awaiting your answer
          </span>
        ) : null}
        {related ? (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="mono text-caption"
            style={{
              marginLeft: state === "open" && isTarget ? 8 : "auto",
              background: "none",
              border: "none",
              color: "var(--fg-4)",
              cursor: "pointer",
            }}
          >
            Collapse
          </button>
        ) : null}
      </div>

      {/* long markdown body */}
      <div style={{ marginTop: 6 }}>{body}</div>

      {/* answer block */}
      {payload ? (
        <div
          style={{
            marginTop: 11,
            border: "var(--hairline) solid var(--border)",
            borderLeft: `var(--hairline-bold) solid ${c.left}`,
            borderRadius: "var(--radius-panel)",
            background:
              state === "open"
                ? "color-mix(in oklch, var(--state-needs-you) 4%, var(--bg-raised))"
                : "var(--bg-sunken)",
            padding: "var(--sp-2_5) var(--sp-3)",
          }}
        >
          <div
            className="mono text-caption font-semibold"
            style={{ color: c.fg, textTransform: "uppercase", marginBottom: 8 }}
          >
            {state === "resolved"
              ? "Answered"
              : state === "closed"
                ? superseded
                  ? "Closed · superseded by an updated question"
                  : "Closed · withdrawn by the asker"
                : canAnswer
                  ? `Your answer · ${questionCount} question${questionCount === 1 ? "" : "s"}`
                  : `Questions · ${questionCount}`}
          </div>

          {payload.questions.map((q, i) => (
            <div key={q.id} style={{ margin: i === 0 ? "0" : "var(--sp-3) 0 0" }}>
              <div className="text-body font-medium" style={{ color: "var(--fg)" }}>
                <span
                  className="mono text-caption"
                  style={{ color: "var(--fg-4)", marginRight: 6 }}
                >{`Q${i + 1}`}</span>
                {q.prompt}
              </div>
              {q.kind === "single" ? (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
                  {q.options.map((opt) => {
                    const staged = canAnswer && choices[q.id] === opt;
                    const isChosen = selections[q.prompt] === opt;
                    const highlight = staged || isChosen;
                    const dim = state === "resolved" && selections[q.prompt] !== undefined && !isChosen;
                    return (
                      <button
                        key={opt}
                        type="button"
                        disabled={!canAnswer}
                        onClick={() => setChoices((prev) => ({ ...prev, [q.id]: opt }))}
                        className={highlight ? "text-body font-semibold" : "text-body"}
                        style={{
                          padding: "var(--sp-1) var(--sp-2_5)",
                          borderRadius: "var(--radius-input)",
                          border: `var(--hairline) solid ${highlight ? "var(--brand)" : "var(--border-strong)"}`,
                          background: highlight ? "var(--brand-bg)" : "var(--bg-raised)",
                          color: highlight ? "var(--brand-dim)" : "var(--fg)",
                          cursor: canAnswer ? "pointer" : "default",
                          opacity: dim ? 0.4 : canAnswer || highlight ? 1 : 0.6,
                        }}
                      >
                        {opt}
                      </button>
                    );
                  })}
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
                    marginTop: 6,
                    border: "var(--hairline) solid var(--border-strong)",
                    borderRadius: "var(--radius-input)",
                    background: "var(--bg-raised)",
                    padding: "var(--sp-1_5) var(--sp-2)",
                    color: "var(--fg)",
                    minHeight: 42,
                    resize: "vertical",
                  }}
                />
              ) : selections[q.prompt] ? (
                <div
                  className="text-body"
                  style={{
                    marginTop: 6,
                    color: "var(--fg-2)",
                    borderLeft: "var(--hairline-bold) solid var(--border)",
                    paddingLeft: "var(--sp-2)",
                  }}
                >
                  {selections[q.prompt]}
                </div>
              ) : (
                <div className="text-caption mono" style={{ color: "var(--fg-4)", marginTop: 4 }}>
                  (free-text answer)
                </div>
              )}
            </div>
          ))}

          {canAnswer ? (
            <div
              style={{
                marginTop: 12,
                display: "flex",
                alignItems: "center",
                gap: 10,
                borderTop: "var(--hairline) solid var(--border-faint)",
                paddingTop: 10,
              }}
            >
              <button
                type="button"
                onClick={submit}
                onKeyDown={onKeyDown}
                disabled={!allRequiredAnswered || mut.isPending}
                className="text-body font-semibold"
                style={{
                  padding: "var(--sp-1_25) var(--sp-4)",
                  borderRadius: "var(--radius-input)",
                  border: "none",
                  cursor: !allRequiredAnswered || mut.isPending ? "not-allowed" : "pointer",
                  background: !allRequiredAnswered || mut.isPending ? "var(--bg-active)" : "var(--brand)",
                  color: !allRequiredAnswered || mut.isPending ? "var(--fg-4)" : "var(--primary-on)",
                }}
              >
                {mut.isPending ? "Sending…" : "Reply"}
              </button>
              <span className="mono text-caption" style={{ color: "var(--fg-4)" }}>
                Selections are staged — Reply to send (⌘↵)
              </span>
            </div>
          ) : null}

          {mut.isError ? (
            <div className="text-caption mono" style={{ color: "var(--state-error)", marginTop: 6 }}>
              Failed to send — try again.
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
