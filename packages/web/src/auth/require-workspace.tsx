import { Navigate, Outlet } from "react-router";
import { useAuth } from "./auth-context.js";

/**
 * Routes inside the regular app shell only make sense once the caller has
 * picked a workspace. A signed-in user with a rootless `type:"user"`
 * token (no membership yet) is bounced to `/setup`. Used in tandem with
 * `RequireAuth` — `RequireAuth` enforces "any token", this layer
 * enforces "per-org token".
 *
 * `workspaces === null` means we haven't fetched yet — render nothing
 * rather than flashing the wrong UI; the auth-context's first-mount
 * effect populates it within a tick.
 */
export function RequireWorkspace() {
  const { isRootless, workspaces } = useAuth();
  if (workspaces === null) return null;
  if (isRootless || workspaces.length === 0) {
    return <Navigate to="/setup" replace />;
  }
  return <Outlet />;
}
