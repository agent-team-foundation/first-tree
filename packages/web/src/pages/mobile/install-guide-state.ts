// Add-to-home-screen ("install as app") guide — pure state, platform detection,
// and auto-show eligibility. Kept free of React/DOM effects so the gating logic
// is unit-testable; the hook in `use-install-guide.ts` wires this to the browser.

const STORAGE_KEY = "first-tree:install-guide";
const SESSION_KEY = "first-tree:install-guide-session";

// The guide auto-shows at most twice across the app's life: once, then one more
// on a later session. A user who *abandons* the sheet (closes the tab) rather
// than explicitly dismissing must still count against this — so the cap is keyed
// on shows, not dismissals. After the cap the Me page keeps a manual entry.
export const MAX_AUTO_SHOWS = 2;

// Timing for the first pop. Anchored to a value moment (the user just opened a
// chat), then a short calm beat so it reads as a breath, not an ambush. The
// dwell fallback catches passive readers who never tap in. Tunable on-device.
export const VALUE_MOMENT_SETTLE_MS = 1800;
export const DWELL_FALLBACK_MS = 25_000;

export type InstallGuideState = {
  /** How many times the guide has auto-shown on this device (the cap key). */
  autoShowCount: number;
  /** Set once the browser fires `appinstalled` — never auto-show again. */
  installed: boolean;
};

export type InstallPlatform = "ios" | "android" | "other";

/** The non-standard iOS-Safari flag plus the standard display-mode query. */
type IosNavigator = Navigator & { standalone?: boolean };

const DEFAULT_STATE: InstallGuideState = { autoShowCount: 0, installed: false };

export function readInstallGuideState(): InstallGuideState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_STATE };
    const parsed = JSON.parse(raw) as Partial<InstallGuideState>;
    return {
      autoShowCount: typeof parsed.autoShowCount === "number" ? parsed.autoShowCount : 0,
      installed: parsed.installed === true,
    };
  } catch {
    // Private-mode denial or corrupt value — behave as a fresh device.
    return { ...DEFAULT_STATE };
  }
}

export function writeInstallGuideState(state: InstallGuideState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // No-op: install state is a nicety, never worth throwing over.
  }
}

export function markInstalled(): void {
  writeInstallGuideState({ ...readInstallGuideState(), installed: true });
}

/** Persist that the guide auto-showed (bumps the lifetime cap counter). */
export function recordAutoShow(): void {
  const state = readInstallGuideState();
  writeInstallGuideState({ ...state, autoShowCount: state.autoShowCount + 1 });
}

// `sessionStorage` scopes "already shown this session" to the tab and clears on
// a fresh tab/launch — a pragmatic proxy for "a later session." It is only a
// same-session de-dupe; the lifetime bound is the localStorage `autoShowCount`.
export function hasShownThisSession(): boolean {
  try {
    return sessionStorage.getItem(SESSION_KEY) === "1";
  } catch {
    return false;
  }
}

export function markShownThisSession(): void {
  try {
    sessionStorage.setItem(SESSION_KEY, "1");
  } catch {
    // No-op.
  }
}

/** Running full-screen from the home screen (already installed)? */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const displayModeStandalone = window.matchMedia?.("(display-mode: standalone)").matches ?? false;
  const iosStandalone = (window.navigator as IosNavigator).standalone === true;
  return displayModeStandalone || iosStandalone;
}

export function detectPlatform(userAgent?: string): InstallPlatform {
  const source = userAgent ?? (typeof navigator !== "undefined" ? navigator.userAgent : "");
  const ua = source.toLowerCase();
  if (/android/.test(ua)) return "android";
  // iPhone/iPod report directly; iPadOS 13+ masquerades as desktop Safari, so
  // fall back to the touch-capable-Mac signal.
  if (/iphone|ipad|ipod/.test(ua)) return "ios";
  if (/macintosh/.test(ua) && typeof navigator !== "undefined" && navigator.maxTouchPoints > 1) return "ios";
  return "other";
}

/**
 * Whether the auto-guide may show at all right now. Deliberately excludes the
 * moment-specific triggers (value moment / dwell / typing / visibility / other
 * overlays) — those live in the hook. This is the durable per-device gate.
 */
export function canAutoShow(input: {
  state: InstallGuideState;
  standalone: boolean;
  platform: InstallPlatform;
  hasContent: boolean;
  shownThisSession: boolean;
}): boolean {
  const { state, standalone, platform, hasContent, shownThisSession } = input;
  if (standalone || state.installed) return false; // already installed
  if (platform === "other") return false; // desktop / unknown — nothing to install to
  if (state.autoShowCount >= MAX_AUTO_SHOWS) return false; // lifetime cap
  if (shownThisSession) return false; // at most once per session
  if (!hasContent) return false; // don't sell "install" over an empty feed
  return true;
}
