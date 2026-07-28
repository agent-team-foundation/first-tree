import { useEffect } from "react";
import { trackEvent } from "../../analytics.js";
import { isStandalone } from "./install-guide-state.js";

const STORAGE_KEY = "first-tree:mobile-standalone-opened";

/**
 * Runs before auth routing so a newly installed PWA opening into sign-in is
 * counted, not only users who make it through OAuth to MobileShell.
 */
export function MobileStandaloneOpenTracker() {
  useEffect(() => {
    if (!isStandalone()) return;
    try {
      if (localStorage.getItem(STORAGE_KEY) === "1") return;
      localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      // Analytics is optional. Storage denial must never block the mobile app.
    }
    trackEvent("mobile_standalone_first_open");
  }, []);

  return null;
}
