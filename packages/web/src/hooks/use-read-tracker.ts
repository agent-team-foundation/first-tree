/**
 * Continuously tracks the message at the bottom edge of the chat
 * viewport, then persists two ids per-chat into IndexedDB:
 *
 *  - `bottomVisibleMessageId` — the live scroll-position anchor.
 *    Read on chat-open to scroll the user back to where they
 *    visually left off.
 *  - `latestKnownMessageId` — the chronologically latest message
 *    present at write time (the chat tip). Read on chat-open to
 *    decide which messages count as "new since last visit"
 *    (everything strictly newer than this id).
 *
 * Both ids are written together on every persistence event so the
 * pair is always coherent.
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
import { captureBrowserStorageScope } from "../lib/browser-storage-scope.js";

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
 * Sub-pixel tolerance when comparing a node's bottom edge to the
 * viewport bottom. Browser layout can produce fractional pixels
 * (especially after `scrollIntoView({block:'end'})`) where a node
 * the user clearly sees as fully visible has its `rect.bottom` at
 * `viewportBottom + 0.4` due to rounding. A strict `<=` test would
 * then exclude it and the tracker would walk past the correct
 * anchor; an unbounded `<= viewportBottom + ε` invites the row
 * BELOW the anchor (whose top is exactly at viewport bottom). A
 * one-pixel epsilon splits the difference: tolerant of sub-pixel
 * rounding, strict enough to never accept a row that isn't
 * visually present.
 */
const VIEWPORT_BOTTOM_EPSILON_PX = 1;

/**
 * Returns the id of the bottom-most message that is FULLY visible
 * inside the container's current viewport — i.e. the message whose
 * bottom edge is at (or within sub-pixel rounding of) the viewport
 * bottom. A message whose top has entered the viewport bottom but
 * whose bottom still extends below the fold does NOT count as
 * seen — the user hasn't actually read it yet.
 *
 * Coordinate space: uses `getBoundingClientRect()` for both the
 * container and each node so all positions are in viewport
 * coordinates. The prior `offsetTop`/`offsetHeight` form depended
 * on `offsetParent`, which is not necessarily the scroll container
 * when intervening relative-positioned wrappers exist — that
 * coordinate-space mismatch is what made the watermark advance
 * past the visible row after `scrollIntoView({block:'end'})`
 * (PR 286 manual sign-off rev 7, code-reviewer repro Test 4).
 *
 * Falls back to the first DOM message when nothing is fully visible
 * at the bottom (e.g., the container hasn't laid out yet, or the
 * first message is taller than the viewport).
 */
function findBottomVisibleMessageId(container: HTMLElement): string | null {
  const containerBottom = container.getBoundingClientRect().bottom;
  const nodes = container.querySelectorAll<HTMLElement>("[data-message-id]");
  if (nodes.length === 0) return null;
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    if (!node) continue;
    const rect = node.getBoundingClientRect();
    if (rect.bottom <= containerBottom + VIEWPORT_BOTTOM_EPSILON_PX) {
      return node.dataset.messageId ?? null;
    }
  }
  // Fallback: nothing fully visible (container not laid out, or the
  // first message is taller than the viewport). Return the first
  // DOM message so consumers have something to anchor against.
  return nodes[0]?.dataset.messageId ?? null;
}

/**
 * Returns the id of the LAST `[data-message-id]` node in the
 * container — i.e., the latest message by `createdAt` (since the
 * timeline is sorted ascending). This is what gets persisted as
 * `latestKnownMessageId`: the chat tip at write time, used on the
 * next visit to decide which messages are truly "new since you
 * were last here".
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
  const storageScopeRef = useRef(captureBrowserStorageScope());
  // Latest computed bottom-visible id. Kept in a ref so write/flush
  // paths can read it without depending on React state churn.
  const bottomVisibleIdRef = useRef<string | null>(null);
  // Latest known message id (chat tip) captured at the last
  // successful recompute. Held in a ref so flushNow can persist it
  // without re-querying the DOM — the DOM at unmount/cleanup time
  // can already belong to the NEXT chat (React re-renders before
  // effect cleanup runs), and re-querying then would write the
  // wrong chat's tip into this chat's IDB row. Caught in PR 286
  // rev 8: A → C → A → return-to-C produced a C-row with A's tip,
  // which silently degraded next-visit unread detection on C.
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

  // Reset on chat switch — the previous chat's bottomVisibleId /
  // latestKnownId are not meaningful for the new chat.
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

      // Capture the chat tip live. flushNow reads this from the ref
      // rather than re-querying the DOM (the DOM at unmount time
      // belongs to the NEXT chat already — see latestKnownIdRef
      // comment above).
      const lk = findLatestMessageId(container);
      if (lk) latestKnownIdRef.current = lk;

      const bottomVisible = findBottomVisibleMessageId(container);
      const bottomVisibleChanged = bottomVisible !== bottomVisibleIdRef.current;
      if (!bottomVisibleChanged) return;
      bottomVisibleIdRef.current = bottomVisible;
      onBottomVisibleChangeRef.current?.(bottomVisible);

      // Schedule a debounced IDB write. The write captures whatever
      // the refs hold at the moment the timer fires, not at the
      // moment of scheduling — so back-to-back scroll events
      // collapse into one write.
      if (writeTimerRef.current) clearTimeout(writeTimerRef.current);
      writeTimerRef.current = setTimeout(() => {
        writeTimerRef.current = null;
        // Same staleness guard at write time: a chat switch may
        // have happened between schedule and fire.
        if (currentChatIdRef.current !== chatId) return;
        const bv = bottomVisibleIdRef.current;
        const lkAtFire = latestKnownIdRef.current;
        if (!bv || !lkAtFire) return;
        void setReadState(chatId, bv, lkAtFire, storageScopeRef.current).then(() =>
          onWriteRef.current?.(chatId, bv, lkAtFire),
        );
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
      // flushNow runs, the refs still hold the OLD chat's
      // pre-switch values.
      //
      // Both ids are read from refs — NOT re-queried from the DOM.
      // At cleanup time React has already committed the next chat's
      // DOM into the container, so a fresh DOM query would return
      // the new chat's tip and write it under the OLD chat's IDB
      // row, corrupting the next visit to the OLD chat. The refs
      // hold the last-observed values from when the OLD chat was
      // actually on screen.
      const bv = bottomVisibleIdRef.current;
      const lk = latestKnownIdRef.current;
      if (!bv || !lk) return;
      void setReadState(chatId, bv, lk, storageScopeRef.current).then(() => onWriteRef.current?.(chatId, bv, lk));
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
