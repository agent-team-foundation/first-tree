/**
 * Floating "↓ N new messages" pill that surfaces unseen messages
 * below the current viewport. Visible whenever there are messages
 * newer than the bottom-visible message id, regardless of why the
 * user is not at the bottom (scrolled up, came back to a chat with
 * new arrivals, or just got new arrivals while sitting in chat).
 *
 * Click → scroll to the very bottom of the chat. The chat-view
 * caller is responsible for both the scroll and for the side-effect
 * of advancing the bottom-visible message id (so the pill disappears
 * after the click resolves).
 *
 * Origin: proposal `hub-chat-scroll-and-cache.20260509.md` (M3
 * absorbed into M2 during PR 286 manual sign-off) — see issue
 * first-tree-all 121.
 */

import { ArrowDown } from "lucide-react";

export function NewMessagesPill({ count, onClick }: { count: number; onClick: () => void }) {
  const label = count === 1 ? "1 new message" : `${count} new messages`;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="absolute inline-flex items-center font-medium shadow-md"
      style={{
        // Sit above the input composer with comfortable breathing
        // room; offset from the right so it does not collide with
        // the timeline content.
        bottom: "var(--sp-3)",
        right: "var(--sp-4)",
        gap: "var(--sp-1_5)",
        height: "var(--sp-7)",
        padding: "0 var(--sp-3)",
        borderRadius: 999,
        border: "var(--hairline) solid var(--primary)",
        background: "var(--bg-raised)",
        color: "var(--primary)",
        cursor: "pointer",
        zIndex: 5,
      }}
    >
      <ArrowDown className="h-3 w-3" />
      <span style={{ fontVariantNumeric: "tabular-nums" }}>{label}</span>
    </button>
  );
}
