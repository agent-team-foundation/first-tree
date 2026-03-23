import { Navigate, Outlet } from "react-router";
import { useAuth } from "./auth-context.js";

export function RequireAuth() {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }
  return <Outlet />;
}
