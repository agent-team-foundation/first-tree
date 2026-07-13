import { useEffect, useRef } from "react";

const ROOT_SCROLL_GUARD_CLASS = "ios-standalone-root-scroll-guard";

function isIosDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  if (/iPad|iPhone|iPod/.test(navigator.userAgent)) return true;

  // iPadOS can identify itself as macOS while retaining touch input.
  return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
}

function isStandaloneDisplayMode(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;

  const displayModeStandalone = window.matchMedia?.("(display-mode: standalone)").matches === true;
  const legacyIosStandalone = "standalone" in navigator && navigator.standalone === true;
  return displayModeStandalone || legacyIosStandalone;
}

export function isIosStandalone(): boolean {
  return isIosDevice() && isStandaloneDisplayMode();
}

function rootHasScrollOffset(): boolean {
  const root = document.documentElement;
  const body = document.body;
  return (
    window.scrollX !== 0 ||
    window.scrollY !== 0 ||
    root.scrollLeft !== 0 ||
    root.scrollTop !== 0 ||
    body.scrollLeft !== 0 ||
    body.scrollTop !== 0
  );
}

/**
 * iOS standalone Web Apps can retain a root scroll range equal to the bottom
 * safe-area inset after the software keyboard closes (WebKit 292603). The
 * mobile pages already own their scrolling, so any window/document scroll is
 * invalid and can be clamped back to the origin without losing page position.
 *
 * `resetKey` lets route changes trigger a fresh clamp. visualViewport events
 * are signals only: its dimensions are themselves unreliable in standalone
 * mode, so this guard never derives layout height from them.
 */
export function useIosStandaloneRootScrollGuard(resetKey: string): void {
  const scheduleClampRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!isIosStandalone()) return;

    const root = document.documentElement;
    const visualViewport = window.visualViewport;
    let animationFrame: number | null = null;

    const clampRootScroll = () => {
      animationFrame = null;
      if (!rootHasScrollOffset()) return;

      window.scrollTo(0, 0);
      // Keep both legacy scrolling roots at the origin as a fallback for iOS
      // versions that disagree about which element owns the root scroll.
      document.documentElement.scrollLeft = 0;
      document.documentElement.scrollTop = 0;
      document.body.scrollLeft = 0;
      document.body.scrollTop = 0;
    };

    const scheduleClamp = () => {
      if (animationFrame !== null) return;
      animationFrame = window.requestAnimationFrame(clampRootScroll);
    };

    const onVisibilityChange = () => {
      if (!document.hidden) scheduleClamp();
    };

    scheduleClampRef.current = scheduleClamp;
    root.classList.add(ROOT_SCROLL_GUARD_CLASS);
    scheduleClamp();
    window.addEventListener("scroll", scheduleClamp, { passive: true });
    window.addEventListener("pageshow", scheduleClamp);
    window.addEventListener("orientationchange", scheduleClamp);
    document.addEventListener("focusout", scheduleClamp);
    document.addEventListener("visibilitychange", onVisibilityChange);
    visualViewport?.addEventListener("resize", scheduleClamp);
    visualViewport?.addEventListener("scroll", scheduleClamp);

    return () => {
      scheduleClampRef.current = null;
      root.classList.remove(ROOT_SCROLL_GUARD_CLASS);
      window.removeEventListener("scroll", scheduleClamp);
      window.removeEventListener("pageshow", scheduleClamp);
      window.removeEventListener("orientationchange", scheduleClamp);
      document.removeEventListener("focusout", scheduleClamp);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      visualViewport?.removeEventListener("resize", scheduleClamp);
      visualViewport?.removeEventListener("scroll", scheduleClamp);
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
    };
  }, []);

  useEffect(() => {
    if (resetKey.length > 0) scheduleClampRef.current?.();
  }, [resetKey]);
}
