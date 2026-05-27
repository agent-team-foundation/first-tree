import type { Attention, AttentionOptionGroup, AttentionQuestion } from "@first-tree/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useMemo, useState } from "react";
import { attentionsInChatQueryKey, respondAttention, respondAttentionMutationKey } from "../../api/attention.js";
import { useAgentNameMap } from "../../lib/use-agent-name-map.js";
import { Markdown } from "../ui/markdown.js";
import { formatElapsed } from "./working-chip.js";

/**
 * AttentionCard — chat-bottom rendering of an open NHA request.
 *
 * Two visual states (per `/tmp/nha-design/ui-mockup.html` v0.8):
 *   - **Expanded** (default): full form with subject / body markdown /
 *     options / free-text / submit action row
 *   - **Collapsed**: three-row strip (composer-height) — title row (with
 *     subject inline) + one-line excerpt + one-line recommended-action row.
 *     Composer still does NOT show — folding is for "let me see the chat
 *     history", not for "let me bypass the question"
 *
 * Question modes:
 *   - **single-question** (default): `metadata.options` may carry one
 *     options group; otherwise the card degrades to free-text only
 *   - **multi-question**: `metadata.questions[]` carries N decision points;
 *     submission is atomic (all questions must be answered)
 *
 * Out of M2 初 scope (still TODO):
 *   - sidebar / popover rendering (separate component)
 *
 * Layout uses project design tokens (--sp-*, --fg-*, --bg-*) only — the
 * design-token guardrails are enforced by `scripts/check-design-tokens.sh`.
 *
 * Successful respond → onResponded callback + invalidates the per-chat
 * attention list (so the bottom-card disappears and the composer comes
 * back into view).
 */
export type AttentionCardProps = {
  attention: Attention;
  /** Called after a successful respond mutation. */
  onResponded?: (attention: Attention) => void;
};

const TICK_INTERVAL_MS = 1000;
const ANSWER_KEY = "default";

/** Live wall-clock elapsed since `createdAt`, re-rendering each second. */
function useLiveSince(iso: string): string {
  const startedAt = useMemo(() => new Date(iso).getTime(), [iso]);
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);
  return formatElapsed(now - startedAt);
}

function formatClockTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  } catch {
    return "--:--";
  }
}

/** Short correlation id for the strip chip. */
function shortAttentionId(id: string): string {
  return id.length <= 8 ? id : id.slice(0, 8);
}

export function AttentionCard({ attention, onResponded }: AttentionCardProps) {
  const queryClient = useQueryClient();
  const agentName = useAgentNameMap();
  const fromName = agentName(attention.originAgentId);

  // Resolve question form. metadata.questions[] takes priority; otherwise
  // we synthesize a single-question form from metadata.options. The
  // single-question form's id is "default" — the same key that respond
  // already uses for answers.
  const questions: AttentionQuestion[] = useMemo(() => {
    if (attention.metadata.questions && attention.metadata.questions.length > 0) {
      return attention.metadata.questions;
    }
    const opts: AttentionOptionGroup | null = attention.metadata.options ?? null;
    if (!opts) return [];
    return [{ id: ANSWER_KEY, prompt: attention.subject, options: opts }];
  }, [attention.metadata.questions, attention.metadata.options, attention.subject]);

  const isMultiQuestion = questions.length > 1;
  const singleOptionsGroup: AttentionOptionGroup | null =
    !isMultiQuestion && questions[0]?.options ? questions[0].options : null;
  const isMultiOption = singleOptionsGroup?.mode === "multi";

  // Selection state. Keyed by question id; value is a set of selected
  // option values for that question. Initialized from each question's
  // own defaultValue.
  const initialAnswers = useMemo<Map<string, Set<string>>>(() => {
    const map = new Map<string, Set<string>>();
    for (const q of questions) {
      const def = q.options?.defaultValue;
      if (!def) {
        map.set(q.id, new Set());
      } else if (Array.isArray(def)) {
        map.set(q.id, new Set(def));
      } else {
        map.set(q.id, new Set([def]));
      }
    }
    return map;
  }, [questions]);

  const [answers, setAnswers] = useState<Map<string, Set<string>>>(initialAnswers);
  const [freeTextOpen, setFreeTextOpen] = useState(questions.length === 0);
  const [freeText, setFreeText] = useState("");
  // Manual fold; default expanded. Folding hides body + actions but keeps
  // the composer suppressed — see the file header comment.
  const [collapsed, setCollapsed] = useState(false);

  const mutation = useMutation({
    mutationKey: respondAttentionMutationKey(attention.id),
    mutationFn: (body: { text?: string; answers?: Record<string, unknown> }) => respondAttention(attention.id, body),
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: attentionsInChatQueryKey(attention.originChatId) });
      onResponded?.(updated);
    },
  });

  const canSubmitFreeText = freeTextOpen && freeText.trim().length > 0;
  /**
   * Per-question validity. A question is "answered" when its selected
   * set's size satisfies the options' `min` (default 1 for single / 1 for
   * multi when unspecified) and `max`. Questions with no options are
   * treated as text-only and therefore never satisfied in form mode (free
   * text is the only path).
   */
  const allQuestionsAnswered = useMemo(() => {
    if (questions.length === 0 || freeTextOpen) return false;
    for (const q of questions) {
      if (!q.options) return false;
      const sel = answers.get(q.id) ?? new Set<string>();
      const min = q.options.min ?? 1;
      const max = q.options.max;
      if (sel.size < min) return false;
      if (max !== undefined && sel.size > max) return false;
    }
    return true;
  }, [answers, freeTextOpen, questions]);
  const canSubmit = canSubmitFreeText || allQuestionsAnswered;

  const toggleOption = useCallback(
    (questionId: string, value: string) => {
      if (mutation.isPending) return;
      const q = questions.find((qq) => qq.id === questionId);
      if (!q?.options) return;
      const optionsMulti = q.options.mode === "multi";
      setAnswers((prev) => {
        const next = new Map(prev);
        const prevSet = next.get(questionId) ?? new Set<string>();
        if (optionsMulti) {
          const updated = new Set(prevSet);
          if (updated.has(value)) updated.delete(value);
          else updated.add(value);
          next.set(questionId, updated);
        } else {
          next.set(questionId, new Set([value]));
        }
        return next;
      });
    },
    [mutation.isPending, questions],
  );

  const handleSubmit = useCallback(() => {
    if (!canSubmit || mutation.isPending) return;
    if (canSubmitFreeText) {
      mutation.mutate({ text: freeText.trim() });
      return;
    }
    // Atomic submit: serialize every question's selection into one answers
    // payload. Single-select keeps the historical scalar shape; multi-select
    // sends an array.
    const payload: Record<string, string | string[]> = {};
    for (const q of questions) {
      const sel = Array.from(answers.get(q.id) ?? []);
      const optionsMulti = q.options?.mode === "multi";
      payload[q.id] = optionsMulti ? sel : (sel[0] ?? "");
    }
    mutation.mutate({ answers: payload });
  }, [answers, canSubmit, canSubmitFreeText, freeText, mutation, questions]);

  // Compact "recommended action" — clicking submits the agent-supplied
  // default option (single-question + single-mode only). Multi-question
  // and multi-select questions degrade to "展开查看".
  const recommendedItem = useMemo(() => {
    if (isMultiQuestion || !singleOptionsGroup || isMultiOption) return null;
    const defaultValue =
      typeof singleOptionsGroup.defaultValue === "string"
        ? singleOptionsGroup.defaultValue
        : singleOptionsGroup.defaultValue?.[0];
    if (!defaultValue) return null;
    return singleOptionsGroup.items.find((it) => it.value === defaultValue) ?? null;
  }, [isMultiQuestion, isMultiOption, singleOptionsGroup]);

  const submitRecommended = useCallback(() => {
    if (!recommendedItem || mutation.isPending || isMultiQuestion) return;
    mutation.mutate({ answers: { [ANSWER_KEY]: recommendedItem.value } });
  }, [isMultiQuestion, mutation, recommendedItem]);

  const compactExcerpt = useMemo(() => {
    const raw = (attention.body || attention.subject).trim();
    const firstLine = raw.split("\n").find((l) => l.trim().length > 0) ?? "";
    return firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine;
  }, [attention.body, attention.subject]);

  const anySelected = useMemo(() => {
    for (const set of answers.values()) {
      if (set.size > 0) return true;
    }
    return false;
  }, [answers]);

  // Keyboard: Enter submits when not in free-text mode (Cmd/Ctrl+Enter in
  // free-text). Esc clears the current selection across all questions —
  // per the mockup's "enter 提交 · esc 取消选中" hint. Scoped to the card;
  // the chat-level Esc handler is unaffected since we stopPropagation only
  // when consuming.
  const handleCardKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.nativeEvent.isComposing) return;
      if (e.key === "Enter" && !e.shiftKey && (e.metaKey || e.ctrlKey || !freeTextOpen)) {
        if (canSubmit) {
          e.preventDefault();
          handleSubmit();
        }
        return;
      }
      if (e.key === "Escape") {
        if (anySelected) {
          e.preventDefault();
          e.stopPropagation();
          setAnswers(new Map(questions.map((q) => [q.id, new Set<string>()])));
        }
      }
    },
    [anySelected, canSubmit, freeTextOpen, handleSubmit, questions],
  );

  const elapsed = useLiveSince(attention.createdAt);
  const clock = formatClockTime(attention.createdAt);

  return (
    <div style={{ padding: "var(--sp-2_5) var(--sp-6) var(--sp-3)" }}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: card-scoped keyboard
          shortcuts (Enter submits, Esc clears selection) bubble from real
          interactive children (buttons, textarea); the wrapper is intentionally
          a presentational region, not a focus target. */}
      <div
        data-attention-id={attention.id}
        data-pending-question-agent={attention.originAgentId}
        onKeyDown={handleCardKeyDown}
        style={{
          maxWidth: "clamp(55rem, 75%, 70rem)",
          margin: "0 auto",
          background: "var(--bg-raised)",
          border: "var(--hairline) solid var(--fg-error-strong)",
          borderRadius: "var(--radius-panel)",
          boxShadow: "var(--shadow-md)",
          overflow: "hidden",
        }}
      >
        {/* Strip header */}
        <div
          className="flex items-center text-label"
          style={{
            background: "var(--bg-error-soft)",
            color: "var(--fg-error-strong)",
            padding: "var(--sp-1_25) var(--sp-3)",
            gap: "var(--sp-2)",
          }}
        >
          <span
            className="mono text-eyebrow inline-flex items-center"
            style={{
              padding: "var(--sp-0_5) var(--sp-1_5)",
              borderRadius: "var(--radius-chip)",
              background: "var(--fg-error-strong)",
              color: "var(--fg-on-vivid)",
              textTransform: "uppercase",
            }}
          >
            ASK
          </span>
          <span className="mono text-label font-semibold" style={{ color: "var(--fg-error-strong)" }}>
            {fromName}
          </span>
          <span className="mono text-caption" style={{ color: "var(--fg-2)" }}>
            · {clock} · waiting {elapsed}
          </span>
          {collapsed ? (
            <span
              className="text-label"
              style={{
                color: "var(--fg)",
                fontWeight: 600,
                marginLeft: "var(--sp-1)",
                flex: 1,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={attention.subject}
            >
              {attention.subject}
            </span>
          ) : (
            <span style={{ flex: 1 }} />
          )}
          <span className="mono text-caption" style={{ color: "var(--fg-3)" }}>
            {shortAttentionId(attention.id)}
          </span>
          <button
            type="button"
            aria-label={collapsed ? "Expand ask card" : "Collapse ask card to view chat history"}
            title={collapsed ? "Expand" : "Collapse to view history"}
            onClick={() => setCollapsed((v) => !v)}
            className="inline-flex items-center justify-center transition-colors"
            style={{
              background: "transparent",
              border: 0,
              cursor: "pointer",
              padding: "var(--sp-0_5) var(--sp-1_25)",
              borderRadius: "var(--radius-input)",
              color: "var(--fg-error-strong)",
              fontWeight: 700,
            }}
          >
            {collapsed ? "▾ Expand" : "▴ Collapse"}
          </button>
        </div>

        {collapsed ? (
          <CompactRows
            excerpt={compactExcerpt}
            recommendedLabel={recommendedItem?.label ?? null}
            otherCount={
              singleOptionsGroup ? Math.max(0, singleOptionsGroup.items.length - (recommendedItem ? 1 : 0)) : 0
            }
            hasOptions={singleOptionsGroup != null || isMultiQuestion}
            isMultiQuestion={isMultiQuestion}
            isPending={mutation.isPending}
            onSubmitRecommended={submitRecommended}
            onExpand={() => setCollapsed(false)}
          />
        ) : null}

        {/* Body */}
        <div
          style={{
            padding: "var(--sp-3) var(--sp-4) var(--sp-3)",
            maxHeight: "56vh",
            overflowY: "auto",
            display: collapsed ? "none" : "block",
          }}
        >
          <div className="text-subtitle font-semibold" style={{ color: "var(--fg)", marginBottom: "var(--sp-2_5)" }}>
            {attention.subject}
          </div>

          {attention.body ? <Markdown>{attention.body}</Markdown> : null}

          {questions.map((q, idx) => (
            <QuestionBlock
              key={q.id}
              question={q}
              index={isMultiQuestion ? idx + 1 : null}
              total={isMultiQuestion ? questions.length : null}
              selected={answers.get(q.id) ?? new Set<string>()}
              disabled={mutation.isPending || freeTextOpen}
              onToggle={(value) => toggleOption(q.id, value)}
            />
          ))}

          {freeTextOpen ? (
            <div style={{ marginTop: "var(--sp-2_5)" }}>
              <textarea
                value={freeText}
                onChange={(e) => setFreeText(e.target.value)}
                placeholder="Free-form reply…"
                rows={3}
                disabled={mutation.isPending}
                className="w-full outline-none text-body"
                style={{
                  padding: "var(--sp-2) var(--sp-2_5)",
                  background: "var(--bg-raised)",
                  border: "var(--hairline) solid var(--border)",
                  borderRadius: "var(--radius-input)",
                  color: "var(--fg)",
                  resize: "vertical",
                  minHeight: "var(--sp-8)",
                }}
              />
            </div>
          ) : null}

          {mutation.isError ? (
            <p className="mono text-label" style={{ color: "var(--state-error)", marginTop: "var(--sp-1_5)" }}>
              {mutation.error instanceof Error ? mutation.error.message : "Failed to submit"}
            </p>
          ) : null}
        </div>

        {/* Actions row */}
        <div
          className="flex items-center"
          style={{
            gap: "var(--sp-2)",
            padding: "var(--sp-2) var(--sp-4) var(--sp-3)",
            borderTop: "var(--hairline) solid var(--border-faint)",
            background: "var(--bg-raised)",
            display: collapsed ? "none" : "flex",
          }}
        >
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit || mutation.isPending}
            className="text-body font-medium inline-flex items-center justify-center transition-opacity"
            style={{
              padding: "var(--sp-1_5) var(--sp-3)",
              borderRadius: "var(--radius-input)",
              background: "var(--fg)",
              color: "var(--bg-raised)",
              border: 0,
              cursor: !canSubmit || mutation.isPending ? "not-allowed" : "pointer",
              opacity: !canSubmit || mutation.isPending ? 0.4 : 1,
            }}
          >
            {mutation.isPending ? "Submitting…" : questions.length > 0 && !freeTextOpen ? "Submit selection" : "Reply"}
          </button>
          {questions.length > 0 ? (
            <button
              type="button"
              onClick={() => setFreeTextOpen((v) => !v)}
              disabled={mutation.isPending}
              className="text-body inline-flex items-center justify-center transition-colors"
              style={{
                padding: "var(--sp-1_5) var(--sp-2_5)",
                background: "transparent",
                color: "var(--fg-2)",
                border: "var(--hairline) solid var(--border)",
                borderRadius: "var(--radius-input)",
                cursor: mutation.isPending ? "not-allowed" : "pointer",
              }}
            >
              {freeTextOpen ? "Back to options…" : "Switch to free-form…"}
            </button>
          ) : null}
          <span style={{ flex: 1 }} />
          <span className="mono text-caption" style={{ color: "var(--fg-4)" }}>
            enter to submit · esc to clear
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * Two-row compact body shown only when the card is folded. Excerpt row is
 * a single-line ellipsised view of the body; recommend row offers a quick
 * action — the agent-supplied default option if any (single-mode only;
 * multi requires explicit selection so we degrade to "展开查看").
 */
function CompactRows({
  excerpt,
  recommendedLabel,
  otherCount,
  hasOptions,
  isMultiQuestion,
  isPending,
  onSubmitRecommended,
  onExpand,
}: {
  excerpt: string;
  recommendedLabel: string | null;
  otherCount: number;
  hasOptions: boolean;
  isMultiQuestion: boolean;
  isPending: boolean;
  onSubmitRecommended: () => void;
  onExpand: () => void;
}) {
  return (
    <>
      <div
        className="text-caption"
        style={{
          padding: "var(--sp-1_25) var(--sp-3)",
          color: "var(--fg-2)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          borderTop: "var(--hairline) solid var(--border-faint)",
          background: "var(--bg-raised)",
        }}
        title={excerpt}
      >
        {excerpt || "(no body)"}
      </div>
      <div
        className="flex items-center"
        style={{
          padding: "var(--sp-1_25) var(--sp-3) var(--sp-1_5)",
          borderTop: "var(--hairline) solid var(--border-faint)",
          background: "var(--bg-raised)",
          gap: "var(--sp-2)",
        }}
      >
        {recommendedLabel && !isMultiQuestion ? (
          <button
            type="button"
            onClick={onSubmitRecommended}
            disabled={isPending}
            className="text-label font-medium inline-flex items-center justify-center transition-opacity"
            style={{
              padding: "var(--sp-1) var(--sp-2_5)",
              borderRadius: "var(--radius-input)",
              background: "var(--fg)",
              color: "var(--bg-raised)",
              border: 0,
              cursor: isPending ? "not-allowed" : "pointer",
              opacity: isPending ? 0.4 : 1,
            }}
          >
            {isPending ? "Submitting…" : `${recommendedLabel} (recommended)`}
          </button>
        ) : (
          <span className="text-caption" style={{ color: "var(--fg-3)" }}>
            {isMultiQuestion
              ? "Multi-question — expand to answer each"
              : hasOptions
                ? "Multi-select — expand to choose"
                : "Free-form reply — expand to type"}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={onExpand}
          className="text-caption transition-colors"
          style={{
            background: "transparent",
            border: 0,
            color: "var(--accent)",
            cursor: "pointer",
            padding: 0,
            textDecoration: "underline",
            textUnderlineOffset: "var(--sp-0_5)",
          }}
        >
          {otherCount > 0 ? `${otherCount} more option${otherCount === 1 ? "" : "s"} — expand →` : "Expand →"}
        </button>
      </div>
    </>
  );
}

/**
 * One question block. For single-question Attentions, `index` is null and
 * the prompt is rendered as just a section title. For multi-question, the
 * prompt is prefixed with "1 / N" so the human can see progress.
 */
function QuestionBlock({
  question,
  index,
  total,
  selected,
  disabled,
  onToggle,
}: {
  question: AttentionQuestion;
  index: number | null;
  total: number | null;
  selected: ReadonlySet<string>;
  disabled: boolean;
  onToggle: (value: string) => void;
}) {
  return (
    <div style={{ marginTop: "var(--sp-3)" }}>
      {index !== null && total !== null ? (
        <div
          className="mono text-caption"
          style={{ color: "var(--fg-3)", marginBottom: "var(--sp-0_75)", textTransform: "uppercase" }}
        >
          Question {index} / {total}
        </div>
      ) : null}
      <div className="text-body font-semibold" style={{ color: "var(--fg)", marginBottom: "var(--sp-1)" }}>
        {question.prompt}
      </div>
      {question.context ? (
        <div className="text-label" style={{ color: "var(--fg-2)", marginBottom: "var(--sp-1_5)" }}>
          <Markdown>{question.context}</Markdown>
        </div>
      ) : null}
      {question.options ? (
        <OptionsList group={question.options} selected={selected} disabled={disabled} onToggle={onToggle} />
      ) : (
        <p className="text-label" style={{ color: "var(--fg-3)" }}>
          This question needs a free-form reply — use the "Switch to free-form…" button below.
        </p>
      )}
    </div>
  );
}

function OptionsList({
  group,
  selected,
  disabled,
  onToggle,
}: {
  group: AttentionOptionGroup;
  selected: ReadonlySet<string>;
  disabled: boolean;
  onToggle: (value: string) => void;
}) {
  const isMulti = group.mode === "multi";
  return (
    <ul
      style={{
        listStyle: "none",
        padding: 0,
        margin: "var(--sp-2_5) 0 0",
        display: "flex",
        flexDirection: "column",
        gap: "var(--sp-1_5)",
      }}
    >
      {group.items.map((item) => {
        const isSelected = selected.has(item.value);
        return (
          <li key={item.value}>
            <button
              type="button"
              aria-pressed={isSelected}
              aria-label={item.label}
              disabled={disabled}
              onClick={() => onToggle(item.value)}
              className="w-full text-left transition-colors"
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: "var(--sp-2)",
                padding: "var(--sp-1_75) var(--sp-2_5)",
                border: `var(--hairline) solid ${isSelected ? "var(--accent)" : "var(--border)"}`,
                background: isSelected ? "var(--accent-bg)" : "var(--bg-raised)",
                borderRadius: "var(--radius-input)",
                cursor: disabled ? "not-allowed" : "pointer",
                opacity: disabled ? 0.6 : 1,
              }}
            >
              <OptionIndicator isMulti={isMulti} isSelected={isSelected} />
              <span style={{ minWidth: 0, flex: 1 }}>
                <span className="text-body font-semibold" style={{ display: "block", color: "var(--fg)" }}>
                  {item.label}
                </span>
                {item.hint ? (
                  <span
                    className="text-label"
                    style={{ display: "block", color: "var(--fg-3)", marginTop: "var(--sp-0_5)" }}
                  >
                    {item.hint}
                  </span>
                ) : null}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Pure-presentation radio/checkbox glyph. Sized via `--sp-*` tokens (the
 * outer dimension uses `--sp-3_5`) so the mockup's indicator size is
 * preserved without raw pixel literals.
 */
function OptionIndicator({ isMulti, isSelected }: { isMulti: boolean; isSelected: boolean }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: "var(--sp-3_5)",
        height: "var(--sp-3_5)",
        marginTop: "var(--sp-0_75)",
        flexShrink: 0,
        border: `var(--hairline-bold) solid ${isSelected ? "var(--accent)" : "var(--fg-4)"}`,
        borderRadius: isMulti ? "var(--radius-chip)" : "50%",
        background: isSelected
          ? isMulti
            ? "var(--accent)"
            : "radial-gradient(circle at center, var(--accent) 0 40%, var(--bg-raised) 50%)"
          : "var(--bg-raised)",
        position: "relative",
      }}
    >
      {isSelected && isMulti ? (
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            left: "var(--sp-0_75)",
            top: 0,
            width: "var(--sp-1)",
            height: "var(--sp-2)",
            border: "solid var(--fg-on-vivid)",
            borderWidth: "0 var(--hairline-bold) var(--hairline-bold) 0",
            transform: "rotate(45deg)",
          }}
        />
      ) : null}
    </span>
  );
}
