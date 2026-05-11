import {
  type QuestionAnswerMessageContent,
  type QuestionItem,
  type QuestionMessageContent,
  type QuestionPreviewFormat,
  questionAnswerMessageContentSchema,
  questionMessageContentSchema,
} from "@agent-team-foundation/first-tree-hub-shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { submitQuestionAnswer } from "../../api/questions.js";
import { cn } from "../../lib/utils.js";
import { Button } from "../ui/button.js";
import { OptionCard } from "./option-card.js";

/**
 * Lifecycle status of a rendered question card. Derived from a join across:
 *   - the `format: "question"` message itself (always present)
 *   - any `format: "question_answer"` message in the same chat that
 *     references this `correlationId` (means the user has answered or it
 *     was answered on another device)
 *   - server-pushed supersede signals (chat archive / claim transfer —
 *     surfaced on next message-list refetch via the question's pending
 *     row no longer being `pending`)
 *
 * For v1 we collapse the answered + superseded distinction into the
 * presence/absence of a matching answer message. A fuller audit will
 * land in commit 6 once we have the WS notification path.
 */
export type QuestionStatus = "pending" | "answered" | "superseded";

const FREE_TEXT_SENTINEL = "__free_text__";

type AnswerSelection = {
  /** For multiSelect: ordered set of selected labels. For single-select: at most one entry. */
  picked: string[];
  /** When the "Other..." sentinel is selected, this is the user's typed answer. */
  freeText: string;
};

function emptySelection(): AnswerSelection {
  return { picked: [], freeText: "" };
}

function selectionToAnswer(question: QuestionItem, sel: AnswerSelection): string | null {
  // "Other..." takes precedence — typed text is the literal answer.
  if (sel.picked.includes(FREE_TEXT_SENTINEL)) {
    const trimmed = sel.freeText.trim();
    return trimmed.length === 0 ? null : trimmed;
  }
  if (sel.picked.length === 0) return null;
  if (!question.multiSelect) return sel.picked[0] ?? null;
  return sel.picked.join(", ");
}

/**
 * Render an agent-emitted question card. Three possible visual states:
 *   - pending  → highlighted border, options interactive, single submit button
 *   - answered → de-highlighted, user's pick checkmarked, others greyed out,
 *                "You answered: X" recap line
 *   - superseded → fully greyed, "(superseded)" tag, all interaction killed
 *
 * Per-message renderer — caller (chat-view.tsx) maps `format=question`
 * messages to this component and `format=question_answer` to a compact
 * recap row (handled by callers since it's a single line).
 */
export function QuestionMessage({
  chatId,
  questionMessageId: _questionMessageId,
  content,
  answer,
  status,
}: {
  chatId: string;
  questionMessageId: string;
  content: QuestionMessageContent;
  /** When the user (or another device) has already answered, the matching content. */
  answer: QuestionAnswerMessageContent | null;
  status: QuestionStatus;
}) {
  const isPending = status === "pending";
  const isAnswered = status === "answered";
  const isSuperseded = status === "superseded";

  const [selections, setSelections] = useState<Record<string, AnswerSelection>>(() => {
    const initial: Record<string, AnswerSelection> = {};
    for (const q of content.questions) initial[q.question] = emptySelection();
    return initial;
  });

  // When an answer arrives mid-edit (another device, or our own optimistic
  // mutation succeeds), reconcile the local picker so the answered view
  // reflects the canonical answers.
  useEffect(() => {
    if (!answer) return;
    const next: Record<string, AnswerSelection> = {};
    for (const q of content.questions) {
      const recorded = answer.answers[q.question];
      if (!recorded) {
        next[q.question] = emptySelection();
        continue;
      }
      const optionLabels = new Set(q.options.map((o) => o.label));
      const tokens = q.multiSelect ? recorded.split(/,\s*/u) : [recorded];
      const matched = tokens.filter((t) => optionLabels.has(t));
      if (matched.length === tokens.length && matched.length > 0) {
        next[q.question] = { picked: matched, freeText: "" };
      } else {
        // Free-text path — no matching option label.
        next[q.question] = { picked: [FREE_TEXT_SENTINEL], freeText: recorded };
      }
    }
    setSelections(next);
  }, [answer, content.questions]);

  const queryClient = useQueryClient();
  const [submitError, setSubmitError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async (answers: Record<string, string>) => submitQuestionAnswer(chatId, content.correlationId, answers),
    onSuccess: () => {
      setSubmitError(null);
      // Refetch the messages query so the answered state lands canonically;
      // the caller's chat-view computes the join across question + answer.
      queryClient.invalidateQueries({ queryKey: ["chat-messages", chatId] });
    },
    onError: (err: unknown) => {
      setSubmitError(err instanceof Error ? err.message : String(err));
    },
  });

  const onSubmit = useCallback(() => {
    setSubmitError(null);
    const answers: Record<string, string> = {};
    for (const q of content.questions) {
      const sel = selections[q.question] ?? emptySelection();
      const value = selectionToAnswer(q, sel);
      if (value === null) {
        setSubmitError(`Please answer "${q.question}" before submitting.`);
        return;
      }
      answers[q.question] = value;
    }
    mutation.mutate(answers);
  }, [content.questions, selections, mutation]);

  const allAnswered = useMemo(() => {
    return content.questions.every((q) => {
      const sel = selections[q.question] ?? emptySelection();
      return selectionToAnswer(q, sel) !== null;
    });
  }, [content.questions, selections]);

  return (
    <div
      className={cn("rounded-[var(--radius-panel)] border flex flex-col", isPending ? "" : "opacity-80")}
      style={{
        padding: "var(--sp-3)",
        gap: "var(--sp-3)",
        borderColor: isPending ? "var(--accent)" : "var(--border)",
        background: "var(--bg-raised)",
      }}
    >
      <div className="flex items-baseline" style={{ gap: "var(--sp-2)" }}>
        <span
          className="mono text-eyebrow font-semibold"
          style={{ color: isPending ? "var(--accent)" : "var(--fg-3)" }}
        >
          AGENT QUESTION
        </span>
        {isAnswered ? (
          <span className="mono text-caption" style={{ color: "var(--fg-3)" }}>
            • Answered
          </span>
        ) : null}
        {isSuperseded ? (
          <span className="mono text-caption" style={{ color: "var(--fg-4)" }}>
            • Superseded
          </span>
        ) : null}
      </div>

      <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
        {content.questions.map((q) => (
          <QuestionBlock
            key={q.question}
            question={q}
            previewFormat={content.previewFormat}
            selection={selections[q.question] ?? emptySelection()}
            allowFreeText={content.allowFreeText}
            disabled={!isPending}
            showAnsweredCheck={isAnswered || isSuperseded}
            onChange={(next) =>
              setSelections((prev) => ({
                ...prev,
                [q.question]: next,
              }))
            }
          />
        ))}
      </div>

      {isPending ? (
        <div className="flex items-center justify-end" style={{ gap: "var(--sp-2)" }}>
          {submitError ? (
            <span className="text-caption" style={{ color: "var(--state-danger)" }}>
              {submitError}
            </span>
          ) : null}
          <Button type="button" disabled={!allAnswered || mutation.isPending} onClick={onSubmit}>
            {mutation.isPending ? "Submitting…" : "Submit answer"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function QuestionBlock({
  question,
  previewFormat,
  selection,
  allowFreeText,
  disabled,
  showAnsweredCheck,
  onChange,
}: {
  question: QuestionItem;
  previewFormat: QuestionPreviewFormat;
  selection: AnswerSelection;
  allowFreeText: boolean;
  disabled: boolean;
  showAnsweredCheck: boolean;
  onChange: (next: AnswerSelection) => void;
}) {
  // Programmatic focus is user-initiated (revealed only after they click
  // "Other…"), so it's accessible — biome's `noAutofocus` rule blocks the
  // declarative `autoFocus` attribute, this useEffect+ref achieves the
  // same intent without tripping it.
  const freeTextRef = useRef<HTMLTextAreaElement>(null);
  const isFreeTextPicked = selection.picked.includes(FREE_TEXT_SENTINEL);
  useEffect(() => {
    if (isFreeTextPicked && !disabled) freeTextRef.current?.focus();
  }, [isFreeTextPicked, disabled]);

  const togglePick = useCallback(
    (label: string) => {
      const isPicked = selection.picked.includes(label);
      let nextPicked: string[];
      if (question.multiSelect) {
        nextPicked = isPicked ? selection.picked.filter((l) => l !== label) : [...selection.picked, label];
      } else {
        nextPicked = isPicked ? [] : [label];
      }
      onChange({ ...selection, picked: nextPicked });
    },
    [question.multiSelect, selection, onChange],
  );

  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
      <div className="flex items-baseline" style={{ gap: "var(--sp-2)" }}>
        <span className="mono text-eyebrow font-semibold" style={{ color: "var(--fg-2)" }}>
          {question.header}
        </span>
        {question.multiSelect ? (
          <span className="mono text-caption" style={{ color: "var(--fg-4)" }}>
            (pick any)
          </span>
        ) : null}
      </div>
      <div className="text-body" style={{ color: "var(--fg)" }}>
        {question.question}
      </div>
      <div className="flex flex-col" style={{ gap: "var(--sp-1_5)" }}>
        {question.options.map((option) => (
          <OptionCard
            key={option.label}
            option={option}
            previewFormat={previewFormat}
            selected={selection.picked.includes(option.label)}
            disabled={disabled}
            showCheckmark={showAnsweredCheck}
            onToggle={() => togglePick(option.label)}
          />
        ))}
        {allowFreeText ? (
          <button
            type="button"
            disabled={disabled}
            onClick={
              disabled
                ? undefined
                : () =>
                    onChange({
                      picked: question.multiSelect
                        ? isFreeTextPicked
                          ? selection.picked.filter((l) => l !== FREE_TEXT_SENTINEL)
                          : [...selection.picked, FREE_TEXT_SENTINEL]
                        : isFreeTextPicked
                          ? []
                          : [FREE_TEXT_SENTINEL],
                      freeText: selection.freeText,
                    })
            }
            className={cn(
              "w-full text-left rounded-[var(--radius-input)] border transition-colors",
              "flex flex-col",
              disabled ? "cursor-default opacity-70" : "cursor-pointer hover:bg-[color:var(--bg-hover)]",
            )}
            style={{
              padding: "var(--sp-2_5) var(--sp-3)",
              gap: "var(--sp-1_5)",
              borderColor: isFreeTextPicked ? "var(--accent)" : "var(--border)",
              background: isFreeTextPicked ? "var(--bg-active)" : "var(--bg-raised)",
            }}
          >
            <span
              className="mono text-body font-semibold"
              style={{ color: isFreeTextPicked ? "var(--accent)" : "var(--fg-3)" }}
            >
              Other…
            </span>
            <span className="text-caption" style={{ color: "var(--fg-4)" }}>
              Type a free-text answer.
            </span>
            {isFreeTextPicked ? (
              <textarea
                ref={freeTextRef}
                value={selection.freeText}
                disabled={disabled}
                onChange={(e) => onChange({ ...selection, freeText: e.target.value })}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  // Enter inserts a newline; Cmd/Ctrl-Enter is reserved for the
                  // submit button so the user can't accidentally submit a
                  // half-typed answer by pressing Enter once.
                  if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
                    // Default behaviour (newline) — but stop click bubbling.
                    e.stopPropagation();
                  }
                }}
                rows={2}
                className="rounded-[var(--radius-input)] border text-body"
                style={{
                  padding: "var(--sp-2)",
                  borderColor: "var(--border)",
                  background: "var(--bg-sunken)",
                  color: "var(--fg)",
                  resize: "vertical",
                }}
              />
            ) : null}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Type guard for `format=question` messages — caller uses to pick this renderer. */
export function isQuestionContent(content: unknown): content is QuestionMessageContent {
  return questionMessageContentSchema.safeParse(content).success;
}

/** Type guard for `format=question_answer` messages — caller uses to fold answers
 *  back into a question card. */
export function isQuestionAnswerContent(content: unknown): content is QuestionAnswerMessageContent {
  return questionAnswerMessageContentSchema.safeParse(content).success;
}
