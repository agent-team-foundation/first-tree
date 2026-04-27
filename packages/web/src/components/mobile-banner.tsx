import { useEffect, useState } from "react";

const STORAGE_KEY = "first-tree-hub:mobile-banner-dismissed";
const MOBILE_MAX_WIDTH_PX = 768;

/**
 * Top banner that fires on phone-sized viewports — M8 P2 in
 * docs/saas-onboarding-journey.md. First Tree Hub's wizard requires
 * pasting a CLI command into a real terminal; we don't try to make
 * that work on a phone. The banner just sets expectations: "switch
 * to a desktop browser to finish setup."
 *
 * Dismiss is sticky via localStorage so the banner doesn't pop back
 * up on every navigation. Re-renders cheap; the effect runs once
 * on mount to read the storage value.
 */
export function MobileBanner() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const dismissed = window.localStorage.getItem(STORAGE_KEY) === "1";
    const isMobile = window.matchMedia(`(max-width: ${MOBILE_MAX_WIDTH_PX}px)`).matches;
    setShow(!dismissed && isMobile);
  }, []);

  if (!show) return null;

  return (
    <div
      role="alert"
      className="fixed inset-x-0 top-0 z-50 flex items-start justify-between gap-2 border-b border-border bg-card text-body"
      style={{ padding: "var(--sp-2) var(--sp-3)" }}
    >
      <div>
        <strong>Best on desktop.</strong> First Tree Hub's setup wizard needs a terminal — switch to a laptop browser to
        connect your machine.
      </div>
      <button
        type="button"
        className="text-caption underline"
        style={{ color: "var(--fg-3)" }}
        onClick={() => {
          window.localStorage.setItem(STORAGE_KEY, "1");
          setShow(false);
        }}
        aria-label="Dismiss mobile banner"
      >
        Dismiss
      </button>
    </div>
  );
}
