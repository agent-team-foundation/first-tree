/**
 * AskTakeover — the pop-up answer card for a `format="request"` ask that blocks
 * THIS chat for the viewer. Rendered as a scrim + centered card INSIDE the
 * workspace body (the message list + composer area), so the topic header and the
 * right rail stay visible around it. One ask per card:
 *
 *   - the ask itself is the message BODY (`content`), rendered as markdown — and
 *     it is the ONLY scrolling region of the card;
 *   - the answer surface stays fixed below it: 2–4 option cards (single = radio,
 *     multi = checkbox; each shows label + description, and `preview` when
 *     selected) plus an always-present free-text "Other" input — or, when the ask
 *     carries no options, a single free-text box;
 *   - the Skip / Reply actions follow the answer content (Skip dismisses for now,
 *     the open-request persists; Reply resolves with the composed answer).
 *
 * The answer is plain text: selected option labels join on one line, any typed
 * note follows — `buildResolveAnswer` owns the format. This is the ONLY way to
 * resolve a question: the target human answers here, in the web UI; an agent can
 * only ask, never answer or close.
 */
import type { AskOption, AskRequest } from "@first-tree/shared";
import { useState } from "react";
import { Markdown } from "../ui/markdown.js";
import { allRequiredAnswered, buildResolveAnswer } from "./request-state.js";

export function AskTakeover({
  body,
  payload,
  askerName,
  sending = false,
  onReply,
  onSkip,
}: {
  /** The ask itself — the request message's markdown body. */
  body: string;
  payload: AskRequest;
  askerName?: string;
  sending?: boolean;
  /** Resolve the question with the composed answer content. */
  onReply: (content: string) => void;
  /** Dismiss the takeover without answering (the open-request persists). */
  onSkip: () => void;
}) {
  const options = payload.options;
  const multi = payload.multiSelect === true;
  const [selected, setSelected] = useState<string[]>([]);
  const [freeText, setFreeText] = useState("");

  const toggle = (label: string) => {
    setSelected((prev) => {
      if (multi) return prev.includes(label) ? prev.filter((l) => l !== label) : [...prev, label];
      return prev.includes(label) ? [] : [label];
    });
  };

  const canReply = allRequiredAnswered(payload, selected, freeText) && !sending;
  const reply = () => {
    if (!canReply) return;
    onReply(buildResolveAnswer(payload, selected, freeText));
  };

  const ftStyle = {
    width: "100%",
    border: "var(--hairline) solid var(--border-strong)",
    borderRadius: "var(--radius-input)",
    background: "var(--bg)",
    color: "var(--fg)",
    fontFamily: "inherit",
    lineHeight: 1.5,
    padding: "var(--sp-2_5) var(--sp-3)",
    resize: "vertical" as const,
    outline: "none",
  };

  return (
    <div
      // Scrim over the workspace body; the ask is a centered card.
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 30,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "clamp(var(--sp-2_5), 2.5%, var(--sp-7))",
        background: "color-mix(in oklch, var(--fg) 10%, transparent)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={askerName ? `Question from ${askerName}` : "Question awaiting your answer"}
        style={{
          // Slightly wider than the message reading column; height fits the
          // content and is capped to the area (50rem cap).
          width: "min(100%, 50rem)",
          maxHeight: "100%",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          background: "var(--bg-raised)",
          border: "var(--hairline) solid var(--border)",
          borderRadius: "var(--radius-dialog)",
          boxShadow: "var(--shadow-md)",
        }}
      >
        {/* The ask — markdown body. The ONLY scrolling region. */}
        <div
          className="text-body"
          style={{
            flex: "1 1 auto",
            minHeight: 0,
            overflowY: "auto",
            padding: "var(--sp-6) var(--sp-6) var(--sp-5)",
            color: "var(--fg-2)",
            lineHeight: 1.6,
          }}
        >
          <Markdown>{body}</Markdown>
        </div>

        {/* Fixed answer block — options + Other (or free text) + actions. */}
        <div
          style={{
            flex: "0 0 auto",
            padding: "var(--sp-4) var(--sp-6) var(--sp-5)",
            borderTop: "var(--hairline) solid var(--border-faint)",
          }}
        >
          {options ? (
            <>
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
                {options.map((opt) => (
                  <OptionRow
                    key={opt.label}
                    opt={opt}
                    multi={multi}
                    selected={selected.includes(opt.label)}
                    onToggle={() => toggle(opt.label)}
                  />
                ))}
              </div>
              <textarea
                value={freeText}
                onChange={(e) => setFreeText(e.target.value)}
                placeholder="Other (type your own)…"
                style={{ ...ftStyle, marginTop: "var(--sp-2)", minHeight: 42 }}
              />
            </>
          ) : (
            <textarea
              value={freeText}
              onChange={(e) => setFreeText(e.target.value)}
              placeholder="Type your answer…"
              style={{ ...ftStyle, minHeight: 110 }}
            />
          )}

          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              alignItems: "center",
              gap: "var(--sp-3)",
              marginTop: "var(--sp-4)",
            }}
          >
            <button
              type="button"
              onClick={onSkip}
              disabled={sending}
              className="text-label"
              style={{
                height: 34,
                padding: "0 var(--sp-4)",
                borderRadius: "var(--radius-input)",
                border: "var(--hairline) solid transparent",
                background: "transparent",
                color: "var(--fg-2)",
                cursor: sending ? "default" : "pointer",
              }}
            >
              Skip
            </button>
            <button
              type="button"
              onClick={reply}
              disabled={!canReply}
              className="text-label"
              style={{
                height: 34,
                padding: "0 var(--sp-4)",
                borderRadius: "var(--radius-input)",
                border: "var(--hairline) solid transparent",
                background: "var(--primary)",
                color: "var(--primary-on)",
                cursor: canReply ? "pointer" : "default",
                opacity: canReply ? 1 : 0.5,
              }}
            >
              {sending ? "Replying…" : "Reply"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function OptionRow({
  opt,
  multi,
  selected,
  onToggle,
}: {
  opt: AskOption;
  multi: boolean;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: the dynamic role is "radio" | "checkbox" — both support aria-checked.
    <button
      type="button"
      role={multi ? "checkbox" : "radio"}
      aria-checked={selected}
      onClick={onToggle}
      style={{
        position: "relative",
        display: "flex",
        alignItems: "flex-start",
        gap: "var(--sp-3)",
        padding: "var(--sp-3)",
        textAlign: "left",
        border: `var(--hairline) solid ${selected ? "var(--border-strong)" : "var(--border)"}`,
        borderRadius: "var(--radius-panel)",
        cursor: "pointer",
        background: selected ? "color-mix(in oklch, var(--fg) 8%, var(--bg-raised))" : "var(--bg)",
        fontWeight: selected ? 500 : 400,
        width: "100%",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 16,
          height: 16,
          flexShrink: 0,
          marginTop: 1,
          border: `var(--hairline-bold) solid ${selected ? "var(--fg)" : "var(--border-strong)"}`,
          borderRadius: multi ? "var(--radius-chip)" : "var(--radius-full)",
          background: selected ? "var(--fg)" : "transparent",
          display: "grid",
          placeItems: "center",
        }}
      >
        {selected ? (
          <span
            style={{
              width: multi ? 8 : 6,
              height: multi ? 8 : 6,
              borderRadius: multi ? 1 : "var(--radius-full)",
              background: "var(--bg-raised)",
            }}
          />
        ) : null}
      </span>
      <span style={{ minWidth: 0 }}>
        <span className="text-body" style={{ color: "var(--fg)", display: "block" }}>
          {opt.label}
        </span>
        <span className="text-body" style={{ color: "var(--fg-3)", display: "block", marginTop: 2 }}>
          {opt.description}
        </span>
        {selected && opt.preview ? (
          <span
            className="mono text-caption"
            style={{
              display: "block",
              marginTop: "var(--sp-2)",
              color: "var(--fg-2)",
              background: "var(--bg-sunken)",
              border: "var(--hairline) solid var(--border-faint)",
              borderRadius: "var(--radius-input)",
              padding: "var(--sp-2)",
              whiteSpace: "pre-wrap",
            }}
          >
            {opt.preview}
          </span>
        ) : null}
      </span>
    </button>
  );
}
