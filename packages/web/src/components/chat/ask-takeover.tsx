/**
 * AskTakeover — the pop-up answer card for a `format="request"` ask that blocks
 * THIS chat for the viewer. Rendered as a scrim + centered card INSIDE the
 * workspace body (the message list + composer area), so the topic header and the
 * right rail stay visible around it. One ask per card:
 *
 *   - the ask body (`content`, rendered as markdown) and the answer surface
 *     below it — 2–4 option cards (single = radio, multi = checkbox; each shows
 *     label + description, and `preview` when selected) plus an always-present
 *     free-text "Other" input, or a single free-text box when the ask carries no
 *     options — share ONE scrolling region, so a long ask plus many options can
 *     never push the controls off-screen;
 *   - the Skip / Reply actions are pinned in a fixed footer below that scroll
 *     region, so Reply stays reachable at any viewport height (notably on phones,
 *     where the card is short and the answer surface used to overflow past the
 *     bottom edge with no way to scroll to it). Both RESOLVE the question: Reply
 *     sends the composed answer; Skip sends a "skipped" answer (the caller's
 *     `onSkip` writes the resolving reply) so the asking agent unblocks rather
 *     than waiting on a never-answered question. There is no "dismiss but keep it
 *     open" path — skip is an answer, not a deferral.
 *
 * The answer is plain text: selected option labels join on one line, any typed
 * note follows — `buildResolveAnswer` owns the format. This is the ONLY way to
 * resolve a question: the target human answers here, in the web UI; an agent can
 * only ask, never answer or close.
 */
import type { AskOption, AskRequest } from "@first-tree/shared";
import { useEffect, useState } from "react";
import { useWorkspaceViewport } from "../../hooks/use-viewport.js";
import { Markdown } from "../ui/markdown.js";
import { allRequiredAnswered, buildResolveAnswer } from "./request-state.js";

/**
 * Height (px) the on-screen keyboard currently steals from the bottom of the
 * layout viewport, via the `visualViewport` API. Zero on desktop and whenever
 * no keyboard is up. The card lifts its bottom by this much so the pinned
 * Skip/Reply footer never hides behind a phone keyboard while the Other box is
 * focused. Robust across both mobile resize models: when the browser shrinks
 * the layout viewport instead (Android `resizes-content`), `innerHeight` falls
 * with `visualViewport.height` and the overlap computes to ~0 on its own.
 */
function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = typeof window === "undefined" ? undefined : window.visualViewport;
    if (!vv) return;
    const update = () => {
      const overlap = window.innerHeight - vv.height - vv.offsetTop;
      setInset(overlap > 1 ? overlap : 0);
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);
  return inset;
}

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
  /** Resolve the question with a "skipped" answer (caller sends the reply). */
  onSkip: () => void;
}) {
  const options = payload.options;
  const multi = payload.multiSelect === true;
  const [selected, setSelected] = useState<string[]>([]);
  const [freeText, setFreeText] = useState("");
  // Tighten the horizontal padding on phone widths so the card uses the
  // available width instead of burning it on gutters.
  const viewport = useWorkspaceViewport();
  const padX = viewport === "narrow" ? "var(--sp-4)" : "var(--sp-6)";
  // Keep the card (and its pinned footer) above the on-screen keyboard.
  const keyboardInset = useKeyboardInset();

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
      // Scrim over the workspace body; the ask is a centered card. The bottom
      // lifts above the on-screen keyboard so the card centers in the visible
      // area and its pinned footer stays reachable while the Other box is typed.
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: keyboardInset,
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
        {/* Scrolling region: the ask body PLUS the answer surface. Keeping the
            options inside the scroller (rather than in a fixed block) is what
            guarantees Reply is reachable — when the card is shorter than its
            content, this whole region clips and scrolls while the footer below
            stays pinned. The only scroller; the card itself never scrolls. */}
        <div
          style={{
            flex: "1 1 auto",
            minHeight: 0,
            overflowY: "auto",
          }}
        >
          {/* The ask — markdown body. */}
          <div
            className="text-body"
            style={{
              padding: `var(--sp-6) ${padX} var(--sp-5)`,
              color: "var(--fg-2)",
              lineHeight: 1.6,
            }}
          >
            <Markdown>{body}</Markdown>
          </div>

          {/* Answer surface — options + Other (or a single free-text box). */}
          <div
            style={{
              padding: `var(--sp-4) ${padX} var(--sp-5)`,
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
          </div>
        </div>

        {/* Pinned footer — Skip / Reply. Fixed (flex 0 0 auto) so it never
            scrolls out of view: Reply is reachable at any viewport height. */}
        <div
          style={{
            flex: "0 0 auto",
            display: "flex",
            justifyContent: "flex-end",
            alignItems: "center",
            gap: "var(--sp-3)",
            padding: `var(--sp-3) ${padX}`,
            borderTop: "var(--hairline) solid var(--border-faint)",
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
              // A long unbroken token (a command, a URL) must wrap instead of
              // overflowing the card horizontally on narrow widths.
              overflowWrap: "anywhere",
            }}
          >
            {opt.preview}
          </span>
        ) : null}
      </span>
    </button>
  );
}
