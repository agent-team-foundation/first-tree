import { ChevronDown } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "../../components/ui/markdown.js";
import { stripInlineMarkdown } from "../../lib/strip-inline-markdown.js";
import { formatRelative } from "../../lib/utils.js";

const MOBILE_SUMMARY_COLLAPSE_LINES = 4;
const MOBILE_SUMMARY_FALLBACK_LINE_HEIGHT_PX = 20.3;

export function MobileCurrentStateCard({
  description,
  descriptionUpdatedAt,
  lastReadAt,
}: {
  description: string | null;
  descriptionUpdatedAt: string | null;
  lastReadAt: string | null;
}) {
  const trimmed = description?.trim() ?? "";
  const plain = useMemo(() => stripInlineMarkdown(trimmed).replace(/\s+/g, " ").trim(), [trimmed]);
  const measurementRef = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => setExpanded(false), [trimmed]);

  useLayoutEffect(() => {
    const measurement = measurementRef.current;
    if (!measurement || !plain) {
      setOverflowing(false);
      setMeasured(true);
      return;
    }

    let active = true;
    const measure = () => {
      if (!active) return;
      const parsedLineHeight = Number.parseFloat(window.getComputedStyle(measurement).lineHeight);
      const lineHeight = Number.isFinite(parsedLineHeight) ? parsedLineHeight : MOBILE_SUMMARY_FALLBACK_LINE_HEIGHT_PX;
      const nextOverflowing =
        measurement.scrollHeight > lineHeight * MOBILE_SUMMARY_COLLAPSE_LINES + 1;
      setOverflowing((current) => (current === nextOverflowing ? current : nextOverflowing));
      setMeasured(true);
    };

    setMeasured(false);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(measurement);
    window.addEventListener("resize", measure);
    void document.fonts?.ready.then(measure);
    return () => {
      active = false;
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [plain]);

  if (!trimmed) return null;

  const updatedAtMs = parseTimestamp(descriptionUpdatedAt);
  const lastReadAtMs = parseTimestamp(lastReadAt);
  const unread = updatedAtMs !== null && (lastReadAtMs === null || updatedAtMs > lastReadAtMs);
  const freshness = updatedAtMs === null ? null : formatRelative(descriptionUpdatedAt);

  return (
    <section
      aria-label="Current state"
      className="surface-raised"
      style={{
        position: "relative",
        padding: "var(--sp-4)",
        marginBottom: "var(--sp-4)",
        background: unread ? "var(--bg-warn-soft)" : "var(--bg-raised)",
        borderColor: unread ? "var(--state-blocked-border)" : "var(--border)",
      }}
      data-mobile-current-state
    >
      <div className="flex items-center" style={{ gap: "var(--sp-2)", marginBottom: "var(--sp-2)" }}>
        <h2 className="text-mobile-subtitle min-w-0 flex-1" style={{ color: "var(--fg)", margin: 0 }}>
          Current state
        </h2>
        {unread ? (
          <span
            className="text-caption shrink-0"
            style={{
              color: "var(--warning)",
              padding: "var(--sp-0_5) var(--sp-1_5)",
              borderRadius: "var(--radius-full)",
              background: "var(--state-blocked-soft)",
            }}
          >
            Updated
          </span>
        ) : null}
        {freshness ? (
          <span className="text-mobile-caption shrink-0" style={{ color: "var(--fg-4)" }}>
            {freshness}
          </span>
        ) : null}
      </div>

      <div
        ref={measurementRef}
        aria-hidden
        className="text-mobile-body"
        style={{
          position: "absolute",
          visibility: "hidden",
          pointerEvents: "none",
          left: "var(--sp-4)",
          right: "var(--sp-4)",
          top: 0,
          margin: 0,
          overflowWrap: "anywhere",
        }}
        data-mobile-current-state-measure
      >
        <Markdown className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_ul]:pl-4 [&_ol]:pl-4">
          {trimmed}
        </Markdown>
      </div>

      {(!measured || overflowing) && !expanded ? (
        <p
          className="text-mobile-body"
          data-mobile-current-state-collapsed
          data-line-clamp={MOBILE_SUMMARY_COLLAPSE_LINES}
          style={{
            color: "var(--fg-2)",
            margin: 0,
            display: "-webkit-box",
            WebkitLineClamp: MOBILE_SUMMARY_COLLAPSE_LINES,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {plain}
        </p>
      ) : (
        <div className="text-mobile-body" style={{ color: "var(--fg-2)" }}>
          <Markdown className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_ul]:pl-4 [&_ol]:pl-4">
            {trimmed}
          </Markdown>
        </div>
      )}

      {measured && overflowing ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="text-mobile-caption inline-flex min-h-11 items-center rounded-[var(--radius-input)] transition-colors hover:bg-[var(--bg-hover)]"
          style={{
            gap: "var(--sp-1)",
            color: "var(--fg)",
            border: 0,
            background: "transparent",
            padding: "var(--sp-2) 0 0",
          }}
        >
          {expanded ? "Show less" : "Show more"}
          <ChevronDown
            aria-hidden
            className="h-3.5 w-3.5"
            style={{ transform: expanded ? "rotate(180deg)" : undefined }}
          />
        </button>
      ) : null}
    </section>
  );
}

function parseTimestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}
