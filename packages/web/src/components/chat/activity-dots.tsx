/**
 * ActivityDots — the conversation-list time-slot indicator for "an agent is
 * producing output right now" (the activity axis, D). Three working-blue dots
 * doing a staggered typing-style wave: no tool name, no timer — at list-scan
 * distance the only question is "is something happening here?", and the detail
 * belongs to the AgentRow / compose status bar. The richer label+timer chip
 * (WorkingChip) is reserved for those focused surfaces.
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
            width: 5,
            height: 5,
            borderRadius: "50%",
            background: "var(--state-working)",
            // Stagger the three dots so the bounce reads as a left-to-right wave.
            animationDelay: `${i * 0.15}s`,
          }}
        />
      ))}
    </span>
  );
}
