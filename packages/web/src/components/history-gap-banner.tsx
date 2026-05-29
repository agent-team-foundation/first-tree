/**
 * Inline marker rendered between two contiguous segments of the chat
 * timeline when the local cache and the server's "last 50" window do not
 * overlap — i.e. the user was away long enough that more than 50 messages
 * went past, leaving a known gap in the middle.
 *
 * The exact size of the gap is unknowable today (UUID v7 message ids are
 * time-ordered but not sequential, and the API has no
 * "count between X and Y" endpoint). Once cursor-based history pagination
 * is wired up (a separate milestone), this banner will be superseded by an
 * actual on-demand fill and can be removed.
 *
 * Origin: proposal `hub-chat-scroll-and-cache.20260509.md` (M1) — see
 * issue first-tree-all 119.
 */
export function HistoryGapBanner() {
  return (
    <div
      className="inline-flex items-center w-full"
      style={{
        margin: "var(--sp-2) 0",
        gap: "var(--sp-2)",
        color: "var(--fg-3)",
      }}
    >
      {/* Hairlines are decorative — hide from screen readers. The caption
          text below carries the actual information and stays readable. */}
      <span aria-hidden="true" style={{ flex: 1, height: "var(--hairline)", background: "var(--border)" }} />
      <span className="text-caption" style={{ whiteSpace: "nowrap" }}>
        Some older messages may not be loaded
      </span>
      <span aria-hidden="true" style={{ flex: 1, height: "var(--hairline)", background: "var(--border)" }} />
    </div>
  );
}
