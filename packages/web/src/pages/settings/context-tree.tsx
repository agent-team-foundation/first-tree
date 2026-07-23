import { Navigate } from "react-router";

/**
 * Compatibility entry for the former Settings → Context tree page. Permanent
 * Team capability setup and recovery now live in Settings → Setup.
 */
export function SettingsContextTreePage() {
  return <Navigate to="/settings/setup" replace />;
}
