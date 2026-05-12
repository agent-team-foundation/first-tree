/**
 * Watches the chat message DOM for which messages have actually been
 * seen by the user, then persists the newest-seen message id per
 * (chatId) into IndexedDB.
 *
 * Two definitions of "seen":
 *  - The DOM element with `data-message-id={id}` enters the viewport
 *    (via IntersectionObserver, threshold high enough to mean "the
 *    line is visible on screen").
 *  - That state lasts at least `visibleHoldMs` milliseconds — so
 *    fast scrolling past does NOT count, but pausing on a line does.
 *
 * The persisted value is monotonic with respect to message creation
 * time (chronological order, ascending by createdAt). We never roll
 * back to an older id even if the user scrolls upward — the marker
 * means "you have seen everything up to this point", not "you are
 * currently looking at this point".
 *
 * Writes are debounced and also flushed when the chat unmounts or the
 * tab becomes hidden, so that closing the tab does not lose the
 * latest seen marker.
 *
 * Origin: proposal `hub-chat-scroll-and-cache.20260509.md` (M2) — see
 * issue first-tree-all 120.
 */

import { type RefObject, useEffect, useRef } from "react";
import { setLastRead } from "../api/read-state-store.js";

type Message = { id: string; createdAt: string };

type UseReadTrackerOptions = {
  /**
   * Container the message DOM lives inside. The IntersectionObserver
   * uses this as its root so visibility is computed relative to the
   * scrolling chat panel, not the browser viewport.
   */
  containerRef: RefObject<HTMLElement | null>;
  /** The current ordered list of messages (ascending by createdAt). */
  messages: readonly Message[];
  /** Chat the messages belong to. Read-state writes are keyed by this. */
  chatId: string;
  /** Hold time before a visible message counts as "seen". Default 500ms. */
  visibleHoldMs?: number;
  /** Debounce for IndexedDB writes during continuous scrolling. Default 1000ms. */
  writeDebounceMs?: number;
  /** Visibility ratio threshold for "in view". Default 0.6 (60% visible). */
  intersectionThreshold?: number;
};

export function useReadTracker({
  containerRef,
  messages,
  chatId,
  visibleHoldMs = 500,
  writeDebounceMs = 1000,
  intersectionThreshold = 0.6,
}: UseReadTrackerOptions): void {
  // The newest message id (by chronological position) we have ever
  // observed as "seen" in this chat session. Monotonic — only moves
  // forward through the messages list, never backward.
  const seenSoFarRef = useRef<string | null>(null);
  // Index in `messages` for the current seenSoFarRef, so monotonic
  // comparisons are O(1) instead of O(n).
  const seenIndexRef = useRef<number>(-1);
  // Set of message ids currently sitting in viewport. They become
  // "seen" only after `visibleHoldMs`.
  const pendingHoldTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Debounce timer for the IDB write.
  const writeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Rebuild the chronological index every time `messages` identity
  // changes. The order is treated as authoritative for monotonicity.
  // Storing as a Map keeps the hot-path lookup O(1).
  const indexByIdRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    const m = new Map<string, number>();
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      if (message) m.set(message.id, i);
    }
    indexByIdRef.current = m;
  }, [messages]);

  // Reset state on chat switch — otherwise we'd carry over the previous
  // chat's seen-pointer when the messages list flips. Note: we DO NOT
  // try to load the previous lastRead from IDB into seenSoFarRef here;
  // tracking is purely forward-looking from the moment the user opens
  // this chat. Existing lastRead is read elsewhere (chat-view) to drive
  // the initial jump-to-position, not to constrain tracking.
  // biome-ignore lint/correctness/useExhaustiveDependencies: chatId is the trigger; the body only touches refs.
  useEffect(() => {
    seenSoFarRef.current = null;
    seenIndexRef.current = -1;
    for (const t of pendingHoldTimersRef.current.values()) clearTimeout(t);
    pendingHoldTimersRef.current.clear();
  }, [chatId]);

  // Wire up the IntersectionObserver + hold-timer + debounced write.
  // Re-runs when chatId changes or when the messages list identity
  // changes (so the observer rebuilds against the new DOM nodes).
  //
  // All three helpers (considerSeen / scheduleWrite / flushNow) are
  // declared inside this effect rather than at hook scope so their
  // identity is stable across renders without needing useCallback
  // gymnastics — Biome's exhaustive-deps lint is happy because the
  // effect closes over them directly, and they only depend on refs.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `messages` keeps the observer in sync with newly-rendered rows; data flows in through indexByIdRef (updated in the effect above).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (typeof IntersectionObserver === "undefined") return;

    // Promote a message id to seen-state if it advances the monotonic
    // counter; otherwise no-op. Returns true if the counter moved.
    const considerSeen = (id: string): boolean => {
      const idx = indexByIdRef.current.get(id);
      if (idx === undefined) return false;
      if (idx <= seenIndexRef.current) return false;
      seenIndexRef.current = idx;
      seenSoFarRef.current = id;
      return true;
    };

    // Schedule / cancel the debounced IDB write. At most one write in
    // flight at a time per chatId.
    const scheduleWrite = () => {
      if (writeTimerRef.current) clearTimeout(writeTimerRef.current);
      writeTimerRef.current = setTimeout(() => {
        writeTimerRef.current = null;
        const id = seenSoFarRef.current;
        if (id) void setLastRead(chatId, id);
      }, writeDebounceMs);
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.messageId;
          if (!id) continue;

          if (entry.isIntersecting) {
            // Already pending? Leave the existing timer alone.
            if (pendingHoldTimersRef.current.has(id)) continue;
            const t = setTimeout(() => {
              pendingHoldTimersRef.current.delete(id);
              const moved = considerSeen(id);
              if (moved) scheduleWrite();
            }, visibleHoldMs);
            pendingHoldTimersRef.current.set(id, t);
          } else {
            // Left viewport before the hold elapsed — cancel the timer
            // so a quick scroll-past does not count as seen.
            const t = pendingHoldTimersRef.current.get(id);
            if (t) {
              clearTimeout(t);
              pendingHoldTimersRef.current.delete(id);
            }
          }
        }
      },
      { root: container, threshold: intersectionThreshold },
    );

    const nodes = container.querySelectorAll<HTMLElement>("[data-message-id]");
    for (const n of nodes) observer.observe(n);

    return () => {
      observer.disconnect();
      for (const t of pendingHoldTimersRef.current.values()) clearTimeout(t);
      pendingHoldTimersRef.current.clear();
    };
    // `messages` in deps so newly-rendered rows get observed when the
    // list grows (poll-driven appends).
  }, [containerRef, chatId, messages, visibleHoldMs, intersectionThreshold, writeDebounceMs]);

  // Flush on tab visibility-hide and on unmount so closing the tab
  // does not drop the latest marker. Helper inlined for the same
  // reason as above — stable closure, no useCallback noise.
  useEffect(() => {
    const flushNow = () => {
      if (writeTimerRef.current) {
        clearTimeout(writeTimerRef.current);
        writeTimerRef.current = null;
      }
      const id = seenSoFarRef.current;
      if (id) void setLastRead(chatId, id);
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
