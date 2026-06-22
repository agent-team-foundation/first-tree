import { useEffect } from "react";
import { useLocation } from "react-router";

/**
 * GA4 analytics for the cloud SPA. The gtag snippet + config live in
 * index.html (property G-BHG918MZ02, cross-domain linker, send_page_view off).
 * This module reports SPA navigations and exposes a typed event helper.
 *
 * Why manual page_view: gtag fires page_view once on initial load. A
 * react-router app changes the URL without a full load, so without this every
 * post-login screen would be invisible. send_page_view is disabled in the
 * config so the first screen is reported here exactly once, not twice.
 */

type GtagArgs =
  | [command: "config", targetId: string, config?: Record<string, unknown>]
  | [command: "event", eventName: string, params?: Record<string, unknown>]
  | [command: "set", params: Record<string, unknown>];

function gtag(...args: GtagArgs): void {
  if (typeof window === "undefined") return;
  const w = window as unknown as { gtag?: (...a: GtagArgs) => void };
  // gtag is defined inline in index.html; guard in case the snippet is absent
  // (e.g. an ad-blocker removed it) so analytics never breaks the app.
  w.gtag?.(...args);
}

/** Report a custom event. Use for conversions like sign_up. No PII in params. */
export function trackEvent(
  name: string,
  params?: Record<string, unknown>,
): void {
  gtag("event", name, params);
}

/**
 * Mount once inside <BrowserRouter>. Reports a page_view on every route
 * change, including the first render.
 */
export function RouteTracker(): null {
  const location = useLocation();
  useEffect(() => {
    const path = location.pathname + location.search;
    gtag("event", "page_view", {
      page_path: path,
      page_location: window.location.href,
      page_title: document.title,
    });
  }, [location.pathname, location.search]);
  return null;
}
