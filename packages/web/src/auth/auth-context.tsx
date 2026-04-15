import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { login as loginApi } from "../api/auth.js";
import { api, clearStoredTokens, getStoredTokens, setStoredTokens } from "../api/client.js";

type MeResponse = {
  member: { role: string };
};

type AuthContextValue = {
  isAuthenticated: boolean;
  role: string | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(() => !!getStoredTokens());
  const [role, setRole] = useState<string | null>(null);

  const logout = useCallback(() => {
    clearStoredTokens();
    setIsAuthenticated(false);
    setRole(null);
  }, []);

  const fetchRole = useCallback(async () => {
    try {
      const data = await api.get<MeResponse>("/me");
      setRole(data.member.role);
    } catch {
      // If /me fails, role stays null — UI falls back to hiding admin features
    }
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const tokens = await loginApi(username, password);
    setStoredTokens({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
    setIsAuthenticated(true);
    // Fetch role immediately after login
    await api
      .get<MeResponse>("/me")
      .then((data) => setRole(data.member.role))
      .catch(() => {});
  }, []);

  // Fetch role on initial load if already authenticated
  useEffect(() => {
    if (isAuthenticated && !role) {
      fetchRole();
    }
  }, [isAuthenticated, role, fetchRole]);

  // Listen for auth failure dispatched by the API client
  useEffect(() => {
    const handler = () => logout();
    window.addEventListener("auth:logout", handler);
    return () => window.removeEventListener("auth:logout", handler);
  }, [logout]);

  return <AuthContext.Provider value={{ isAuthenticated, role, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
