import { Navigate, Outlet, useLocation } from "react-router";
import { LandingPage } from "../pages/landing/index.js";
import { useAuth } from "./auth-context.js";

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
  const { isAuthenticated } = useAuth();
  const location = useLocation();
  if (!isAuthenticated) {
    if (location.pathname === "/") return <LandingPage />;
    // Stash full location (pathname + search + hash) so a deep-link visitor
    // who logs in lands back on the page they originally requested.
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  return <Outlet />;
}
