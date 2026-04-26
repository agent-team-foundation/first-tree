import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { login as loginApi } from "../api/auth.js";
import { api, clearStoredTokens, getStoredTokens, setStoredTokens } from "../api/client.js";

type MeResponse = {
  member: { id: string; role: string; agentId: string };
};

type AuthContextValue = {
  isAuthenticated: boolean;
  role: string | null;
  memberId: string | null;
  agentId: string | null;
  login: (username: string, password: string) => Promise<void>;
  /**
   * Adopt a token pair obtained out-of-band (currently only the loopback-only
   * `local-bootstrap` endpoint). Skips the username/password form entirely so
   * the local-mode user never sees credentials.
   */
  adoptTokens: (tokens: { accessToken: string; refreshToken: string }) => Promise<void>;
  logout: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(() => !!getStoredTokens());
  const [role, setRole] = useState<string | null>(null);
  const [memberId, setMemberId] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);

  const logout = useCallback(() => {
    clearStoredTokens();
    setIsAuthenticated(false);
    setRole(null);
    setMemberId(null);
    setAgentId(null);
  }, []);

  const fetchMe = useCallback(async () => {
    try {
      const data = await api.get<MeResponse>("/me");
      setRole(data.member.role);
      setMemberId(data.member.id);
      setAgentId(data.member.agentId);
    } catch {
      // If /me fails, role stays null — UI falls back to hiding admin features
    }
  }, []);

  const adoptTokens = useCallback(async (tokens: { accessToken: string; refreshToken: string }) => {
    setStoredTokens({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
    setIsAuthenticated(true);
    // Fetch member info immediately after login
    await api
      .get<MeResponse>("/me")
      .then((data) => {
        setRole(data.member.role);
        setMemberId(data.member.id);
        setAgentId(data.member.agentId);
      })
      .catch(() => {});
  }, []);

  const login = useCallback(
    async (username: string, password: string) => {
      const tokens = await loginApi(username, password);
      await adoptTokens(tokens);
    },
    [adoptTokens],
  );

  // Fetch member info on initial load if already authenticated
  useEffect(() => {
    if (isAuthenticated && !role) {
      fetchMe();
    }
  }, [isAuthenticated, role, fetchMe]);

  // Listen for auth failure dispatched by the API client
  useEffect(() => {
    const handler = () => logout();
    window.addEventListener("auth:logout", handler);
    return () => window.removeEventListener("auth:logout", handler);
  }, [logout]);

  return (
    <AuthContext.Provider value={{ isAuthenticated, role, memberId, agentId, login, adoptTokens, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
