/**
 * Continuously tracks which message is at (or nearest to) the bottom
 * edge of the chat viewport, then persists that id per-chat into
 * IndexedDB. On chat open, the UI uses this stored value to scroll
 * the same message back to the viewport bottom — so the user
 * resumes visually where they left off, not "at the bottom of all
 * current content" and not "at the highest message they've ever
 * seen".
 *
 * The tracking signal is the actual scroll position, not visibility
 * dwell time. Two reasons:
 *  - It matches what the user means by "where I was reading"
 *    (their viewport, not what they read).
 *  - It is monotonically tied to their scroll actions — no
 *    surprises from "I touched the bottom for half a second so the
 *    marker jumped to the bottom forever".
 *
 * Writes fire on three triggers:
 *  - debounced scroll-settle (default 600ms after the last scroll
 *    event), so a refresh mid-session preserves the current view
 *  - `visibilitychange = "hidden"` so closing the tab does not lose
 *    the latest snapshot
 *  - component unmount (chat switch) for the same reason
 *
 * Origin: proposal `hub-chat-scroll-and-cache.20260509.md` (M2),
 * revised during PR 286 manual sign-off — see issue
 * first-tree-all 120.
 */

import { type RefObject, useEffect, useRef } from "react";
import { setReadState } from "../api/read-state-store.js";

type Message = { id: string; createdAt: string };

type UseReadTrackerOptions = {
  /**
   * Scrollable container the message DOM lives inside. Used both to
   * read its scroll position and to query for the messages currently
   * laid out within it.
   */
  containerRef: RefObject<HTMLElement | null>;
  /**
   * The current ordered list of messages (ascending by `createdAt`).
   * Used to map back from a DOM-resolved id to its index so we can
   * also publish the live "bottom-visible index" to consumers via
   * `onBottomVisibleChange` for pill-count calculations.
   */
  messages: readonly Message[];
  /** Chat the messages belong to. IDB writes are keyed by this. */
  chatId: string;
  /**
   * Fires after every successful IDB write — both the debounced
   * scroll-settle path and the flush-on-hide / unmount path. The
   * chat-view uses this to keep React Query's in-memory cache for
   * `["chat-read-state", chatId]` in sync with what was just
   * persisted (otherwise a same-session A → B → A would read the
   * stale value).
   *
   * Both ids are passed: `bottomVisibleMessageId` drives the
   * scroll anchor on next visit; `latestKnownMessageId` drives the
   * UnreadDivider count.
   */
  onWrite?: (chatId: string, bottomVisibleMessageId: string, latestKnownMessageId: string) => void;
  /**
   * Fires every time the live bottom-visible message id changes
   * (during scrolling, or as poll-driven new messages shift the
   * layout). The pill uses this to recompute its count without
   * round-tripping through IDB.
   *
   * Distinct from `onWrite`: this fires on every transition, not
   * just on persisted snapshots.
   */
  onBottomVisibleChange?: (bottomVisibleMessageId: string | null) => void;
  /** Settle time before a scroll triggers an IDB write. Default 600ms. */
  writeDebounceMs?: number;
};

/**
 * Looks at the scroll container and returns the id of the message
 * whose top edge is at or above the container's viewport-bottom, but
 * whose bottom edge is below it (i.e. the message that visually
 * "ends" the read region). Falls back to the closest above or below
 * if no element straddles the boundary exactly. Returns `null` when
 * the container has no measurable messages.
 */
function findBottomVisibleMessageId(container: HTMLElement): string | null {
  const viewportBottom = container.scrollTop + container.clientHeight;
  const nodes = container.querySelectorAll<HTMLElement>("[data-message-id]");
  if (nodes.length === 0) return null;
  // Walk from the bottom of the list upward so the first match is
  // the bottom-most visible. Most chats render last-message at the
  // end, so this is short-circuit-friendly.
  let lastVisible: HTMLElement | null = null;
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    if (!node) continue;
    const top = node.offsetTop;
    if (top <= viewportBottom) {
      lastVisible = node;
      break;
    }
  }
  // Fallback: nothing visible above the bottom edge (e.g., container
  // hasn't laid out yet) — return the first DOM message.
  if (!lastVisible) lastVisible = nodes[0] ?? null;
  return lastVisible?.dataset.messageId ?? null;
}

/**
 * Returns the id of the LAST `[data-message-id]` node in the
 * container — i.e., the latest message by `createdAt` (since the
 * timeline is sorted ascending). Distinct from
 * `findBottomVisibleMessageId` — that one is gated by the
 * viewport; this one always returns the chronologically-latest
 * message regardless of whether the user has scrolled to see it.
 *
 * Used to capture `latestKnownMessageId` alongside the visual
 * scroll position, so the UnreadDivider on the next visit can
 * distinguish "messages new since last visit" from "messages that
 * were there but below the user's viewport".
 */
function findLatestMessageId(container: HTMLElement): string | null {
  const nodes = container.querySelectorAll<HTMLElement>("[data-message-id]");
  if (nodes.length === 0) return null;
  const last = nodes[nodes.length - 1];
  return last?.dataset.messageId ?? null;
}

export function useReadTracker({
  containerRef,
  messages,
  chatId,
  onWrite,
  onBottomVisibleChange,
  writeDebounceMs = 600,
}: UseReadTrackerOptions): void {
  // Latest computed bottom-visible id. Kept in a ref so write/flush
  // paths can read it without depending on React state churn.
  const bottomVisibleIdRef = useRef<string | null>(null);
  // Latest message id in the DOM at the most recent recompute. Kept
  // in a ref for the same reason. Distinct from bottomVisibleIdRef
  // because the user's viewport bottom and the chat's latest
  // message are usually different (the user is somewhere in
  // history, not always at the latest).
  const latestKnownIdRef = useRef<string | null>(null);
  // Debounced IDB write timer.
  const writeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Live "which chat is the component currently rendering for".
  // Mutated during render (not in a useEffect) so that any stale
  // observer / effect-cleanup that runs across a chat boundary
  // sees the new value immediately and can bail.
  //
  // Why: when chatId changes A → B and the destination chat is
  // warm-cached, React re-renders with B's messages and DOM commits
  // before the old chatId-A effect cleanup runs. The old effect's
  // MutationObserver fires synchronously on that commit and
  // recomputes the bottom-visible id from B's freshly-rendered
  // rows, pasting a B-message id into the ref. Then the old flush
  // cleanup runs flushNow with the chatId=A closure and writes the
  // B id under A's IDB row — corrupting A's snapshot.
  //
  // Caught in PR 286 manual sign-off rev 3 (R5 fail). Reviewer
  // suggested validating the id against the messages array; the
  // root-cause fix is to drop the write entirely whenever the
  // tracker is stale (chatId has moved on), which both recompute
  // and flushNow guard against by reading this ref live.
  const currentChatIdRef = useRef(chatId);
  currentChatIdRef.current = chatId;

  // Keep latest callbacks reachable from inside effects below
  // without making the effects re-run on every render.
  const onWriteRef = useRef(onWrite);
  const onBottomVisibleChangeRef = useRef(onBottomVisibleChange);
  useEffect(() => {
    onWriteRef.current = onWrite;
  }, [onWrite]);
  useEffect(() => {
    onBottomVisibleChangeRef.current = onBottomVisibleChange;
  }, [onBottomVisibleChange]);

  // Reset on chat switch — the previous chat's bottomVisibleId is
  // not meaningful for the new chat.
  // biome-ignore lint/correctness/useExhaustiveDependencies: chatId is the trigger; the body only touches refs.
  useEffect(() => {
    bottomVisibleIdRef.current = null;
    latestKnownIdRef.current = null;
    if (writeTimerRef.current) {
      clearTimeout(writeTimerRef.current);
      writeTimerRef.current = null;
    }
  }, [chatId]);

  // Continuous scroll + content-mutation tracking. Reads the
  // bottom-visible id, fires the live callback, and schedules a
  // debounced IDB write. Re-runs when `messages` identity changes
  // so newly-rendered rows show up in the DOM-query.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `messages` keeps the listener in sync with newly-rendered rows; data is read live via DOM, not from the closure.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const recompute = () => {
      // Bail if this observer/effect is stale — i.e., chatId has
      // moved on but the old MutationObserver fired between DOM
      // commit and effect cleanup. Without this guard, the OLD
      // closure's recompute would read the NEW chat's DOM and
      // pollute bottomVisibleIdRef with a foreign message id.
      if (currentChatIdRef.current !== chatId) return;

      const bottomVisible = findBottomVisibleMessageId(container);
      const latestKnown = findLatestMessageId(container);
      const bottomVisibleChanged = bottomVisible !== bottomVisibleIdRef.current;
      const latestKnownChanged = latestKnown !== latestKnownIdRef.current;
      if (!bottomVisibleChanged && !latestKnownChanged) return;
      bottomVisibleIdRef.current = bottomVisible;
      latestKnownIdRef.current = latestKnown;
      if (bottomVisibleChanged) onBottomVisibleChangeRef.current?.(bottomVisible);

      // Schedule a debounced IDB write. The write captures whatever
      // bottomVisibleIdRef / latestKnownIdRef hold at the moment the
      // timer fires, not at the moment of scheduling — so back-to-
      // back scroll events collapse into one write.
      if (writeTimerRef.current) clearTimeout(writeTimerRef.current);
      writeTimerRef.current = setTimeout(() => {
        writeTimerRef.current = null;
        // Same staleness guard at write time: a chat switch may
        // have happened between schedule and fire.
        if (currentChatIdRef.current !== chatId) return;
        const bv = bottomVisibleIdRef.current;
        const lk = latestKnownIdRef.current;
        if (!bv || !lk) return;
        void setReadState(chatId, bv, lk).then(() => onWriteRef.current?.(chatId, bv, lk));
      }, writeDebounceMs);
    };

    container.addEventListener("scroll", recompute, { passive: true });
    const mut = new MutationObserver(recompute);
    mut.observe(container, { childList: true, subtree: true });
    // Initial pass so consumers receive the starting value as soon
    // as messages are in the DOM.
    recompute();

    return () => {
      container.removeEventListener("scroll", recompute);
      mut.disconnect();
    };
  }, [containerRef, chatId, messages, writeDebounceMs]);

  // Flush on tab hide and on unmount so closing the tab / switching
  // chats does not drop the latest snapshot.
  useEffect(() => {
    const flushNow = () => {
      if (writeTimerRef.current) {
        clearTimeout(writeTimerRef.current);
        writeTimerRef.current = null;
      }
      // Deliberately no cross-chat-boundary guard here. flushNow
      // runs at unmount precisely so the OLD chat's latest state
      // gets persisted to IDB — that's the legitimate purpose. The
      // pollution-source race is already prevented in the recompute
      // path above (which bails on stale chatId), so by the time
      // flushNow runs, both refs still hold the OLD chat's
      // pre-switch values and a write to setReadState(oldChat, ...)
      // is exactly what we want.
      const bv = bottomVisibleIdRef.current;
      const lk = latestKnownIdRef.current;
      if (!bv || !lk) return;
      void setReadState(chatId, bv, lk).then(() => onWriteRef.current?.(chatId, bv, lk));
    };
    const onVis = () => {
      if (document.visibilityState === "hidden") flushNow();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      flushNow();
    };
  }, [chatId]);
}
