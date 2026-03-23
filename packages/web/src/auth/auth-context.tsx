import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { login as loginApi } from "../api/auth.js";
import { clearStoredTokens, getStoredTokens, setStoredTokens } from "../api/client.js";

type AuthContextValue = {
  isAuthenticated: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(() => !!getStoredTokens());

  const logout = useCallback(() => {
    clearStoredTokens();
    setIsAuthenticated(false);
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const tokens = await loginApi(username, password);
    setStoredTokens({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
    setIsAuthenticated(true);
  }, []);

  // Listen for auth failure dispatched by the API client
  useEffect(() => {
    const handler = () => logout();
    window.addEventListener("auth:logout", handler);
    return () => window.removeEventListener("auth:logout", handler);
  }, [logout]);

  return <AuthContext.Provider value={{ isAuthenticated, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
