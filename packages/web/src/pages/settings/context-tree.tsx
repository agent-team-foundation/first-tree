import { Navigate } from "react-router";

/**
 * Compatibility entry for the former Settings → Context tree page. Repository
 * resources and the Context Tree binding now share Settings → Repositories.
 */
export function SettingsContextTreePage() {
  return <Navigate to="/settings/repositories#context-tree" replace />;
}
