import { Navigate, Outlet } from "react-router";
import { useAuth } from "./auth-context.js";

/**
 * Routes inside the regular app shell only make sense once the caller has
 * picked a workspace. A signed-in user with a rootless `type:"user"`
 * token (no membership yet) is bounced to `/setup`. Used in tandem with
 * `RequireAuth` — `RequireAuth` enforces "any token", this layer
 * enforces "per-org token".
 *
 * `workspaces === null` means we haven't fetched yet. Render a centered
 * "Loading…" instead of nothing — on a slow network the
 * `/me/workspaces` round-trip can take hundreds of ms; a blank screen
 * is worse UX than a clearly-pending one.
 */
export function RequireWorkspace() {
  const { isRootless, workspaces } = useAuth();
  if (workspaces === null) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="text-body text-muted-foreground">Loading…</div>
      </div>
    );
  }
  if (isRootless || workspaces.length === 0) {
    return <Navigate to="/setup" replace />;
  }
  return <Outlet />;
}
