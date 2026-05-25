/**
 * Stable scroll utilities for the chat message list.
 *
 * The motivating problem: when a chat first renders, message rows resize
 * over time as avatars fetch, markdown reflows, and image refs hydrate.
 * Naive `scrollIntoView` / `scrollTop = X` calls fire before the
 * container has settled, then the layout shifts under them and the
 * scroll position no longer points at what we asked for.
 *
 * This hook borrows the pattern Kael's frontend has been running in
 * production: a `ResizeObserver` on the container plus a short debounce
 * — we only perform the scroll once the container has been the same
 * height for `stabilityDelay` ms.
 *
 * Two scroll operations are exposed:
 *  - `scrollToBottom(behavior)` — used after-the-fact for "follow new
 *    message" cases and as the fallback when there is no last-read
 *    marker (preserves the M1 behavior).
 *  - `scrollToMessage(id, position, behavior)` — used by M2's
 *    jump-to-last-read on chat open. `position: 'end'` lands the
 *    message at the bottom of the viewport (so the user sees it as
 *    the last thing already-read, with unread content scrollable
 *    below). `position: 'start'` lands the message at the top.
 *
 * `isAtBottom` is reported continuously so M3's "↓ N new messages"
 * pill can decide whether a poll-driven message should yank scroll or
 * surface a count instead.
 *
 * Origin: proposal `hub-chat-scroll-and-cache.20260509.md` (M2) — see
 * issue first-tree-all 120. Pattern lifted from
 * `kael-frontend/src/hooks/useChatScroll.ts`.
 */

import { type RefObject, useCallback, useEffect, useState } from "react";

type UseChatScrollOptions = {
  /** ms to wait for container height to stop changing before scrolling. */
  stabilityDelay?: number;
  /** Distance from bottom in px below which we consider "at bottom". */
  bottomThreshold?: number;
};

type ScrollPosition = "start" | "end";

type UseChatScrollReturn = {
  /** True when the user's viewport bottom is within `bottomThreshold` of the container's scrollHeight. */
  isAtBottom: boolean;
  /**
   * Scroll the container so its bottom is in view, AFTER container
   * height has stabilised (ResizeObserver-debounced). Right for
   * "follow new message arrival" where async content (images,
   * markdown) might still be rendering.
   */
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  /**
   * Like `scrollToBottom` but synchronous — fires the scroll
   * immediately without waiting for height to stabilise. Right for
   * initial chat-open landing called from a `useLayoutEffect`, so
   * the first paint already shows the bottom (no top-then-bottom
   * flash).
   */
  scrollToBottomImmediate: (behavior?: ScrollBehavior) => void;
  /**
   * Scroll the container so the element with `data-message-id={id}`
   * is in view at `position`, after height has stabilised.
   */
  scrollToMessage: (id: string, position?: ScrollPosition, behavior?: ScrollBehavior) => void;
  /**
   * Like `scrollToMessage` but synchronous — fires the scroll
   * immediately. Right for initial chat-open landing.
   */
  scrollToMessageImmediate: (id: string, position?: ScrollPosition, behavior?: ScrollBehavior) => void;
};

export function useChatScroll(
  containerRef: RefObject<HTMLDivElement | null>,
  options: UseChatScrollOptions = {},
): UseChatScrollReturn {
  const { stabilityDelay = 200, bottomThreshold = 50 } = options;

  const [isAtBottom, setIsAtBottom] = useState(true);

  // Track "is the user near the bottom" — driven by both scroll events
  // (user-initiated) and DOM mutations on the subtree (content streamed
  // in while the user is reading).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const recompute = () => {
      const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
      setIsAtBottom(distance <= bottomThreshold);
    };

    container.addEventListener("scroll", recompute, { passive: true });
    const mut = new MutationObserver(recompute);
    mut.observe(container, { childList: true, subtree: true, characterData: true });
    recompute();

    return () => {
      container.removeEventListener("scroll", recompute);
      mut.disconnect();
    };
  }, [containerRef, bottomThreshold]);

  /**
   * Shared "wait for stable height, then run a scroll callback" helper.
   * Sets up a ResizeObserver that resets the debounce on every resize;
   * once the container has been the same size for `stabilityDelay` ms,
   * the observer disconnects and the callback fires.
   */
  const runAfterStable = useCallback(
    (cb: () => void): void => {
      const container = containerRef.current;
      if (!container) return;

      let stabilityTimer: ReturnType<typeof setTimeout> | null = null;
      const observer = new ResizeObserver(() => {
        if (stabilityTimer) clearTimeout(stabilityTimer);
        stabilityTimer = setTimeout(() => {
          observer.disconnect();
          cb();
        }, stabilityDelay);
      });
      observer.observe(container);
      // Kick off an initial timer in case no resize ever happens (content
      // is already mounted and quiet).
      stabilityTimer = setTimeout(() => {
        observer.disconnect();
        cb();
      }, stabilityDelay);
    },
    [containerRef, stabilityDelay],
  );

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      runAfterStable(() => {
        const container = containerRef.current;
        if (!container) return;
        const top = Math.max(0, container.scrollHeight - container.clientHeight);
        container.scrollTo({ top, behavior });
      });
    },
    [containerRef, runAfterStable],
  );

  const scrollToBottomImmediate = useCallback(
    (behavior: ScrollBehavior = "auto") => {
      const container = containerRef.current;
      if (!container) return;
      const top = Math.max(0, container.scrollHeight - container.clientHeight);
      container.scrollTo({ top, behavior });
    },
    [containerRef],
  );

  const scrollToMessage = useCallback(
    (id: string, position: ScrollPosition = "end", behavior: ScrollBehavior = "auto") => {
      runAfterStable(() => {
        const container = containerRef.current;
        if (!container) return;
        const target = container.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
        if (!target) return;
        target.scrollIntoView({ block: position, behavior });
      });
    },
    [containerRef, runAfterStable],
  );

  const scrollToMessageImmediate = useCallback(
    (id: string, position: ScrollPosition = "end", behavior: ScrollBehavior = "auto") => {
      const container = containerRef.current;
      if (!container) return;
      const target = container.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
      if (!target) return;
      target.scrollIntoView({ block: position, behavior });
    },
    [containerRef],
  );

  return { isAtBottom, scrollToBottom, scrollToBottomImmediate, scrollToMessage, scrollToMessageImmediate };
}
