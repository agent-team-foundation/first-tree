/**
 * Inline "New Messages" marker rendered between the last message
 * the user saw on their previous visit and the first message that
 * arrived while they were away. Snapshotted at chat-open from the
 * persisted `latestKnownMessageId` — its position does not move as
 * new messages stream in during the session.
 *
 * The divider has no count by design (Lark-style): the count lives
 * on the floating pill and tracks the live scroll position. Keeping
 * a number off the divider lets it remain a stable anchor even
 * after the user has scrolled past every new message.
 *
 * Dismissal:
 *  - When the divider scrolls out the top of the viewport (caller
 *    wires an IntersectionObserver and re-renders without it).
 *  - On chat switch (caller re-snapshots from IDB on the next
 *    open).
 *
 * Origin: proposal `hub-chat-scroll-and-cache.20260509.md` revised
 * during PR 286 manual sign-off — the divider was re-introduced
 * after the pill-only iteration could not distinguish messages
 * already-present-but-off-screen from messages truly arrived since
 * the last visit. See issue first-tree-all 120.
 */

import { forwardRef } from "react";

export const UnreadDivider = forwardRef<HTMLDivElement>(function UnreadDivider(_props, ref) {
  return (
    <div
      ref={ref}
      className="inline-flex items-center w-full"
      style={{
        margin: "var(--sp-2) 0",
        gap: "var(--sp-2)",
        color: "var(--primary)",
      }}
    >
      <span aria-hidden="true" style={{ flex: 1, height: "var(--hairline)", background: "var(--primary)" }} />
      <span className="text-caption font-medium" style={{ whiteSpace: "nowrap" }}>
        New Messages
      </span>
      <span aria-hidden="true" style={{ flex: 1, height: "var(--hairline)", background: "var(--primary)" }} />
    </div>
  );
});
