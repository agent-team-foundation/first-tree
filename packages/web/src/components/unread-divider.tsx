/**
 * Inline divider rendered between the last message the user has already
 * read (per local IndexedDB tracking) and the first unread message.
 * Visually similar to HistoryGapBanner (hairline + centered caption)
 * but informational rather than diagnostic — the caption carries an
 * unread count that screen readers should read out.
 *
 * Origin: proposal `hub-chat-scroll-and-cache.20260509.md` (M2) — see
 * issue first-tree-all 120.
 */

export function UnreadDivider({ count }: { count: number }) {
  const label = count === 1 ? "1 new message" : `${count} new messages`;
  return (
    <div
      className="inline-flex items-center w-full"
      style={{
        margin: "var(--sp-2) 0",
        gap: "var(--sp-2)",
        color: "var(--accent)",
      }}
    >
      {/* Hairlines are decorative — hide from screen readers. The
          caption below carries the actual unread count and stays
          readable. */}
      <span aria-hidden="true" style={{ flex: 1, height: "var(--hairline)", background: "var(--accent)" }} />
      <span className="text-caption font-semibold" style={{ whiteSpace: "nowrap" }}>
        {label}
      </span>
      <span aria-hidden="true" style={{ flex: 1, height: "var(--hairline)", background: "var(--accent)" }} />
    </div>
  );
}
