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
import { useAutoResizeTextarea } from "../../lib/use-autoresize-textarea.js";
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

type AnswerSelection = {
  /** Selected option labels. Never contains a free-text marker — the textarea is the source of truth for free text. */
  picked: string[];
  /** User's typed answer. Non-empty means free-text overrides any picked options. */
  freeText: string;
};

function emptySelection(): AnswerSelection {
  return { picked: [], freeText: "" };
}

function selectionToAnswer(question: QuestionItem, sel: AnswerSelection): string | null {
  // Typing into the free-text field is the user's implicit "use my own
  // answer" signal — it always overrides picked options.
  const trimmed = sel.freeText.trim();
  if (trimmed.length > 0) return trimmed;
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
        next[q.question] = { picked: [], freeText: recorded };
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
    // Guard against duplicate submissions from any trigger path — the submit
    // button is `disabled` while pending, but the Cmd/Ctrl+Enter shortcut
    // inside the free-text field reaches us directly and would otherwise fire
    // concurrent POSTs before the answered refetch lands.
    if (mutation.isPending) return;
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
            onSubmit={onSubmit}
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
  onSubmit,
}: {
  question: QuestionItem;
  previewFormat: QuestionPreviewFormat;
  selection: AnswerSelection;
  allowFreeText: boolean;
  disabled: boolean;
  showAnsweredCheck: boolean;
  onChange: (next: AnswerSelection) => void;
  onSubmit: () => void;
}) {
  const togglePick = useCallback(
    (label: string) => {
      const isPicked = selection.picked.includes(label);
      if (question.multiSelect) {
        // Toggle just this label. Any free-text draft is preserved — in
        // multi-select mode, free-text and picked options coexist (free-text
        // wins at submit time).
        const nextPicked = isPicked ? selection.picked.filter((l) => l !== label) : [...selection.picked, label];
        onChange({ ...selection, picked: nextPicked });
      } else {
        // Picking an option is the user's explicit "use this answer" — discard
        // any free-text draft so the picked option becomes the real submission.
        const nextPicked = isPicked ? [] : [label];
        onChange({ picked: nextPicked, freeText: "" });
      }
    },
    [question.multiSelect, selection, onChange],
  );

  const onFreeTextChange = useCallback(
    (value: string) => {
      if (question.multiSelect) {
        onChange({ ...selection, freeText: value });
      } else {
        // Typing custom text means "I want a custom answer instead" — drop
        // any previously picked option so the UI matches what we'll submit.
        onChange({ picked: [], freeText: value });
      }
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
          <FreeTextField
            value={selection.freeText}
            disabled={disabled}
            isMultiSelect={question.multiSelect}
            hasPickedOptions={selection.picked.length > 0}
            questionText={question.question}
            onChange={onFreeTextChange}
            onSubmit={onSubmit}
            showAnsweredCheck={showAnsweredCheck}
          />
        ) : null}
      </div>
    </div>
  );
}

function FreeTextField({
  value,
  disabled,
  isMultiSelect,
  hasPickedOptions,
  questionText,
  onChange,
  onSubmit,
  showAnsweredCheck,
}: {
  value: string;
  disabled: boolean;
  isMultiSelect: boolean;
  hasPickedOptions: boolean;
  /** The question this textarea answers — used for the accessible name so screen readers can tell which question a free-text field belongs to. */
  questionText: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  showAnsweredCheck: boolean;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useAutoResizeTextarea(textareaRef, value);

  const isActive = value.trim().length > 0;

  return (
    <div
      className="rounded-[var(--radius-input)] border flex flex-col"
      style={{
        padding: "var(--sp-2_5) var(--sp-3)",
        gap: "var(--sp-1_5)",
        borderColor: isActive ? "var(--accent)" : "var(--border)",
        background: isActive ? "var(--bg-active)" : "var(--bg-raised)",
        opacity: disabled ? 0.7 : 1,
      }}
    >
      <div className="flex items-baseline" style={{ gap: "var(--sp-2)" }}>
        <span className="mono text-body font-semibold" style={{ color: isActive ? "var(--accent)" : "var(--fg-3)" }}>
          Write your own
        </span>
        {showAnsweredCheck && isActive ? (
          <span className="mono text-caption" style={{ color: "var(--accent)" }} title="Selected">
            ✓
          </span>
        ) : null}
        {isMultiSelect && isActive && hasPickedOptions ? (
          <span className="text-caption" style={{ color: "var(--fg-4)" }}>
            (overrides picked options)
          </span>
        ) : null}
      </div>
      <textarea
        ref={textareaRef}
        value={value}
        disabled={disabled}
        placeholder="Type your own answer…"
        aria-label={`Write your own answer for: ${questionText}`}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // Cmd/Ctrl+Enter submits — plain Enter inserts a newline so users
          // can write multi-line answers without accidentally firing the form.
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSubmit();
          }
        }}
        rows={2}
        className="rounded-[var(--radius-input)] border text-body w-full"
        style={{
          padding: "var(--sp-2)",
          borderColor: "var(--border)",
          background: "var(--bg-sunken)",
          color: "var(--fg)",
          resize: "none",
          maxHeight: "15rem",
          overflowY: "auto",
        }}
      />
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
