import { lazy, Suspense } from "react";
import { Navigate, Outlet, useLocation } from "react-router";
import { useAuth } from "./auth-context.js";

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
