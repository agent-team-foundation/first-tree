import { lazy, Suspense, useEffect, useRef } from "react";
import { Navigate, Outlet, useLocation } from "react-router";
import { isKnownCampaign } from "../pages/quickstart/campaigns.js";
import { beginAuthAttempt } from "./auth-analytics.js";
import { useAuth } from "./auth-context.js";
import { prepareFullPageApiNavigation } from "./full-page-api-navigation.js";

/**
 * Lazy-loaded so the landing-page bundle (LandingPage shell + lucide
 * icons used by the marketing surface) is fetched only when an
 * unauthenticated visitor lands on `/`. Authenticated users — the common
 * case — never download it. Saves ~5–10 KB off the dashboard's auth
 * bundle.
 */
const LandingPage = lazy(() => import("../pages/landing/index.js").then((m) => ({ default: m.LandingPage })));

/**
 * Pre-mount placeholder for the lazy LandingPage chunk. Matches the
 * landing-marketing surface (near-black) so the suspense flash is
 * indistinguishable from the page below — no light flash on first paint
 * even if the chunk takes a few hundred ms over slow 3G.
 */
const LandingFallback = () => <div className="landing-marketing min-h-screen bg-background" />;

/**
 * The scan funnel's own login handoff. A logged-out visitor who arrives at
 * `/quickstart?campaign=<known>&repo=...` is sent STRAIGHT to GitHub OAuth
 * instead of the generic `/login` interstitial — that page is both an extra
 * click and off-message ("Set up your team…") for someone who just clicked
 * "scan my repo". Returns the OAuth `next` (the exact quickstart URL to come
 * back to) when the skip applies, else `null` so normal `/login` routing runs.
 *
 * Only KNOWN campaigns skip: the server's `shouldPreserveSoloSignupNext`
 * preserves the campaign `next` for the scan funnel, so an unknown campaign
 * would OAuth then get dropped to `/` — better to keep those on `/login`.
 * Exported for unit tests.
 */
export function scanCampaignOAuthNext(loc: { pathname: string; search: string }): string | null {
  if (loc.pathname !== "/quickstart") return null;
  const campaign = new URLSearchParams(loc.search).get("campaign");
  if (!isKnownCampaign(campaign)) return null;
  return loc.pathname + loc.search;
}

/**
 * Full-page redirect into the server GitHub OAuth start endpoint. This is a
 * server route (not a router path), so it must be a real navigation, not a
 * `<Navigate>`. Renders the neutral landing fallback while the browser leaves.
 */
function OAuthStartRedirect({ next }: { next: string }) {
  const navigationSequence = useRef(0);
  useEffect(() => {
    const sequence = navigationSequence.current + 1;
    navigationSequence.current = sequence;
    void prepareFullPageApiNavigation(`/api/v1/auth/github/start?next=${encodeURIComponent(next)}`)
      .then((target) => {
        if (navigationSequence.current !== sequence) return;
        beginAuthAttempt("github", next);
        window.location.replace(target);
      })
      .catch(() => {
        // Stay on the neutral veil. A server/process proof failure must never
        // fall back to the unbound OAuth route.
      });
    return () => {
      if (navigationSequence.current === sequence) navigationSequence.current += 1;
    };
  }, [next]);
  return <LandingFallback />;
}

/**
 * Route guard for everything behind the dashboard chrome.
 *
 * Behavior matrix (unauthenticated visitor):
 *   - `/`                 → render the public LandingPage in place
 *   - any other deep link → redirect to `/login` AND stash the original
 *                           location in router state so LoginPage can send
 *                           the user back there after auth succeeds
 *
 * Authenticated users always pass through to the matched child route, so
 * landing on `/` still produces the WorkspacePage as before. We render
 * landing inline (rather than redirecting to a `/landing` URL) so the
 * marketing entry point and the workspace share the canonical `/` URL —
 * the path the user typed never changes between auth states.
 */
export function RequireAuth() {
  const { isAuthenticated, meLoaded } = useAuth();
  const location = useLocation();
  if (!isAuthenticated) {
    if (location.pathname === "/") {
      return (
        <Suspense fallback={<LandingFallback />}>
          <LandingPage />
        </Suspense>
      );
    }
    // Scan funnel: skip the generic /login screen and go straight to GitHub
    // OAuth, returning to this exact /quickstart?campaign=...&repo=... URL.
    const scanNext = scanCampaignOAuthNext(location);
    if (scanNext) return <OAuthStartRedirect next={scanNext} />;
    // Stash full location (pathname + search + hash) so a deep-link visitor
    // who logs in lands back on the page they originally requested.
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  // Authenticated but `/me` hasn't resolved yet — any org-scoped query that
  // mounted now would call `withOrg` before `setApiSelectedOrganizationId`
  // had a value, throw, and React Query wouldn't refetch when the org id
  // later flips. Render the same neutral fallback we use for the lazy
  // LandingPage — keeps visual continuity and gives `fetchMe` one tick to
  // populate the org id before the dashboard mounts and fires its first wave
  // of requests.
  if (!meLoaded) return <LandingFallback />;
  return <Outlet />;
}
