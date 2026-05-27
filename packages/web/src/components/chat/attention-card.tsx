import type { Attention, AttentionOptionGroup } from "@first-tree/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useMemo, useState } from "react";
import { attentionsInChatQueryKey, respondAttention, respondAttentionMutationKey } from "../../api/attention.js";
import { useAgentNameMap } from "../../lib/use-agent-name-map.js";
import { Markdown } from "../ui/markdown.js";
import { formatElapsed } from "./working-chip.js";

/**
 * AttentionCard — M1 末 chat-bottom rendering of an open NHA request.
 *
 * Scope:
 *   - Expanded state only (no collapse affordance — folding lands in M2)
 *   - Single top-level question (the schema's `metadata.questions[]`
 *     multi-question path is M2)
 *   - No sidebar / popover rendering — this card is the chat-bottom card
 *     and is rendered in place of the composer by the chat-view
 *
 * Layout follows `/tmp/nha-design/ui-mockup.html` State B (v0.8). All
 * spacing / color / typography values resolve to the project's existing
 * CSS tokens (--sp-*, --fg-*, --bg-*, .text-* utilities). No raw pixel
 * literals, no inline font properties — the design-token guardrails are
 * enforced by `scripts/check-design-tokens.sh`.
 *
 * The component owns its own selection / free-text / submit state. On a
 * successful respond mutation it calls `onResponded` and invalidates the
 * per-chat attention list so the bottom-card disappears and the composer
 * comes back into view.
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

  const optionsGroup: AttentionOptionGroup | null = attention.metadata.options ?? null;
  const isMulti = optionsGroup?.mode === "multi";

  const initialSelection = useMemo<Set<string>>(() => {
    if (!optionsGroup?.defaultValue) return new Set();
    if (Array.isArray(optionsGroup.defaultValue)) return new Set(optionsGroup.defaultValue);
    return new Set([optionsGroup.defaultValue]);
  }, [optionsGroup]);

  const [selected, setSelected] = useState<Set<string>>(initialSelection);
  const [freeTextOpen, setFreeTextOpen] = useState(!optionsGroup);
  const [freeText, setFreeText] = useState("");

  const mutation = useMutation({
    mutationKey: respondAttentionMutationKey(attention.id),
    mutationFn: (body: { text?: string; answers?: Record<string, unknown> }) => respondAttention(attention.id, body),
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: attentionsInChatQueryKey(attention.originChatId) });
      onResponded?.(updated);
    },
  });

  const canSubmitFreeText = freeTextOpen && freeText.trim().length > 0;
  const canSubmitOptions = optionsGroup != null && selected.size > 0 && !freeTextOpen;
  const canSubmit = canSubmitFreeText || canSubmitOptions;

  const toggleOption = useCallback(
    (value: string) => {
      if (mutation.isPending) return;
      setSelected((prev) => {
        if (isMulti) {
          const next = new Set(prev);
          if (next.has(value)) next.delete(value);
          else next.add(value);
          return next;
        }
        return new Set([value]);
      });
    },
    [isMulti, mutation.isPending],
  );

  const handleSubmit = useCallback(() => {
    if (!canSubmit || mutation.isPending) return;
    if (canSubmitFreeText) {
      mutation.mutate({ text: freeText.trim() });
      return;
    }
    const value: string | string[] = isMulti ? Array.from(selected) : (Array.from(selected)[0] ?? "");
    mutation.mutate({ answers: { [ANSWER_KEY]: value } });
  }, [canSubmit, canSubmitFreeText, freeText, isMulti, mutation, selected]);

  // Keyboard: Enter submits when not in free-text mode (Cmd/Ctrl+Enter in
  // free-text). Esc clears the current selection — per the mockup's
  // "enter 提交 · esc 取消选中" hint. Scoped to the card; the chat-level
  // Esc handler is unaffected since we stopPropagation only when consuming.
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
        if (selected.size > 0) {
          e.preventDefault();
          e.stopPropagation();
          setSelected(new Set());
        }
      }
    },
    [canSubmit, freeTextOpen, handleSubmit, selected.size],
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
            请示 · ASK
          </span>
          <span className="mono text-label font-semibold" style={{ color: "var(--fg-error-strong)" }}>
            {fromName}
          </span>
          <span className="mono text-caption" style={{ color: "var(--fg-2)" }}>
            · {clock} · 已等待 {elapsed}
          </span>
          <span style={{ flex: 1 }} />
          <span className="mono text-caption" style={{ color: "var(--fg-3)" }}>
            {shortAttentionId(attention.id)}
          </span>
        </div>

        {/* Body */}
        <div
          style={{
            padding: "var(--sp-3) var(--sp-4) var(--sp-3)",
            maxHeight: "56vh",
            overflowY: "auto",
          }}
        >
          <div className="text-subtitle font-semibold" style={{ color: "var(--fg)", marginBottom: "var(--sp-2_5)" }}>
            {attention.subject}
          </div>

          {attention.body ? <Markdown>{attention.body}</Markdown> : null}

          {optionsGroup ? (
            <OptionsList
              group={optionsGroup}
              selected={selected}
              disabled={mutation.isPending || freeTextOpen}
              onToggle={toggleOption}
            />
          ) : null}

          {freeTextOpen ? (
            <div style={{ marginTop: "var(--sp-2_5)" }}>
              <textarea
                value={freeText}
                onChange={(e) => setFreeText(e.target.value)}
                placeholder="自由回复…"
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
            {mutation.isPending ? "提交中…" : optionsGroup && !freeTextOpen ? "提交所选" : "回复"}
          </button>
          {optionsGroup ? (
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
              {freeTextOpen ? "改回选项…" : "改用自由回复…"}
            </button>
          ) : null}
          <span style={{ flex: 1 }} />
          <span className="mono text-caption" style={{ color: "var(--fg-4)" }}>
            enter 提交 · esc 取消选中
          </span>
        </div>
      </div>
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
