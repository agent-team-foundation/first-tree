import { Navigate, Outlet, useLocation } from "react-router";
import { useAuth } from "./auth-context.js";

/**
 * Gate any "logged-in user" route. Unauthed callers are bounced to
 * `/signup` (SaaS-first GitHub OAuth) with a `next` carrying the path
 * they were originally trying to reach — that lets the OAuth round-trip
 * land them back where they wanted to go. Self-host installs reach
 * `/login` directly via the user's bookmark; we don't auto-route there.
 */
export function RequireAuth() {
  const { isAuthenticated } = useAuth();
  const location = useLocation();
  if (!isAuthenticated) {
    const next = `${location.pathname}${location.search}${location.hash}`;
    return <Navigate to={`/signup?next=${encodeURIComponent(next)}`} replace />;
  }
  return <Outlet />;
}
