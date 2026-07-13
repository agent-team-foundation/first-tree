import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  canAutoShow,
  DWELL_FALLBACK_MS,
  detectPlatform,
  hasShownThisSession,
  type InstallPlatform,
  isStandalone,
  markInstalled,
  markShownThisSession,
  readInstallGuideState,
  recordAutoShow,
  VALUE_MOMENT_SETTLE_MS,
} from "./install-guide-state.js";

// Chrome/Android fire `beforeinstallprompt` when the manifest meets the install
// criteria. We stash the event so our own sheet can trigger the native install
// (one tap) instead of leaving it to Chrome's easily-missed mini-infobar.
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

export type InstallGuideMode = "native" | "ios" | "android-manual";
export type InstallOutcome = "accepted" | "dismissed" | "unavailable";

// Module-level singleton: the event can fire before the mobile shell mounts, so
// we start listening at import time and replay the captured event to React.
let deferredPrompt: BeforeInstallPromptEvent | null = null;
const subscribers = new Set<() => void>();

function emit(): void {
  for (const notify of subscribers) notify();
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    markInstalled();
    emit();
  });
}

function subscribePrompt(callback: () => void): () => void {
  subscribers.add(callback);
  return () => subscribers.delete(callback);
}

function getPromptSnapshot(): BeforeInstallPromptEvent | null {
  return deferredPrompt;
}

/** Which sheet variant to render, or null when there is nothing to install to. */
export function resolveMode(platform: InstallPlatform, canNativeInstall: boolean): InstallGuideMode | null {
  if (canNativeInstall) return "native";
  if (platform === "ios") return "ios";
  if (platform === "android") return "android-manual";
  return null;
}

/** Platform + captured native prompt. Shared by the auto trigger and the Me-page entry. */
export function useInstallPrompt(): {
  platform: InstallPlatform;
  mode: InstallGuideMode | null;
  install: () => Promise<InstallOutcome>;
} {
  const prompt = useSyncExternalStore(subscribePrompt, getPromptSnapshot, () => null);
  const platform = useMemo(() => detectPlatform(), []);
  const mode = resolveMode(platform, prompt !== null);

  const install = useCallback(async (): Promise<InstallOutcome> => {
    if (!deferredPrompt) return "unavailable";
    const event = deferredPrompt;
    await event.prompt();
    const choice = await event.userChoice;
    deferredPrompt = null;
    emit();
    return choice.outcome;
  }, []);

  return { platform, mode, install };
}

function isTypingSomewhere(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
}

/** Another modal/sheet is already open — don't stack the auto-guide on top. */
function isOverlayOpen(): boolean {
  return typeof document !== "undefined" && document.querySelector('[role="dialog"]') !== null;
}

/**
 * Auto-show state machine for the first-pop guide. The first pop is anchored to
 * a value moment (the user opened a chat) plus a short calm beat; a dwell
 * fallback catches passive readers. Never fires over an open chat, while typing,
 * when backgrounded, or once the per-device cap is hit. See `canAutoShow`.
 */
export function useInstallGuideAuto({ hasContent, immersive }: { hasContent: boolean; immersive: boolean }): {
  open: boolean;
  mode: InstallGuideMode | null;
  install: () => Promise<void>;
  dismiss: () => void;
} {
  const { platform, mode, install } = useInstallPrompt();
  const [open, setOpen] = useState(false);
  const openedChatRef = useRef(false);
  const shownRef = useRef(false);

  const eligible = useCallback((): boolean => {
    if (mode === null) return false;
    return canAutoShow({
      state: readInstallGuideState(),
      standalone: isStandalone(),
      platform,
      hasContent,
      shownThisSession: hasShownThisSession(),
    });
  }, [mode, platform, hasContent]);

  const show = useCallback((): void => {
    if (shownRef.current) return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    if (isTypingSomewhere() || isOverlayOpen()) return;
    if (!eligible()) return;
    shownRef.current = true;
    recordAutoShow();
    markShownThisSession();
    setOpen(true);
  }, [eligible]);

  // Opening a chat is the value moment.
  useEffect(() => {
    if (immersive) openedChatRef.current = true;
  }, [immersive]);

  // Primary trigger: back on a resting screen after having opened a chat.
  useEffect(() => {
    if (open || shownRef.current) return;
    if (immersive || !openedChatRef.current) return;
    if (!eligible()) return;
    const timer = window.setTimeout(show, VALUE_MOMENT_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [open, immersive, eligible, show]);

  // Fallback: passive readers who never open a chat. The timer resets whenever
  // they dip into a chat — those users are served by the value-moment path.
  useEffect(() => {
    if (open || shownRef.current || immersive) return;
    const timer = window.setTimeout(show, DWELL_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [open, immersive, show]);

  // The show was already counted against the cap in `show()`, so dismiss/install
  // just close — no separate dismissal bookkeeping (avoids double-counting).
  const dismiss = useCallback((): void => {
    setOpen(false);
  }, []);

  const onInstall = useCallback(async (): Promise<void> => {
    await install();
    setOpen(false);
  }, [install]);

  return { open: open && mode !== null, mode, install: onInstall, dismiss };
}
