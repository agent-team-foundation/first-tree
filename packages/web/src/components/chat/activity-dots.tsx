/**
 * ActivityDots — the conversation-list time-slot indicator for "an agent is
 * producing output right now" (the activity axis, D). A calm scrolling `•••`
 * in working blue: no tool name, no timer — at list-scan distance the only
 * question is "is something happening here?", and the detail belongs to the
 * AgentRow / compose status bar. The richer label+timer chip (WorkingChip)
 * is reserved for those focused surfaces.
 */
const DOTS = [0, 1, 2];

export function ActivityDots() {
  return (
    <span
      role="status"
      aria-label="working"
      className="inline-flex shrink-0 items-center"
      style={{ gap: 3, color: "var(--state-working)" }}
    >
      {DOTS.map((i) => (
        <span
          key={i}
          aria-hidden="true"
          className="chat-row-activity-dot"
          style={{
            width: 4,
            height: 4,
            borderRadius: "50%",
            background: "var(--state-working)",
            // Stagger the three dots so they read as a left-to-right scroll.
            animationDelay: `${i * 0.2}s`,
          }}
        />
      ))}
    </span>
  );
}
