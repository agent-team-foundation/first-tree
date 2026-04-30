import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { login as loginApi } from "../api/auth.js";
import { api, clearStoredTokens, getStoredTokens, setStoredTokens } from "../api/client.js";
import { clearOnboardingJoinPath } from "../utils/onboarding-flags.js";

type MeUser = {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
};

type MeResponse = {
  user?: MeUser;
  member: { id: string; role: string; agentId: string; organizationId: string };
  wizard?: { step: "connect" | "create_agent" | "completed" };
};

type AuthContextValue = {
  isAuthenticated: boolean;
  role: string | null;
  memberId: string | null;
  agentId: string | null;
  organizationId: string | null;
  user: MeUser | null;
  wizardStep: "connect" | "create_agent" | "completed" | null;
  login: (username: string, password: string) => Promise<void>;
  /**
   * Adopt a token pair handed in from a non-login surface (OAuth fragment
   * consumer, switch-org response, accept-invite). Mirrors what `login`
   * does after the API call: persist tokens + warm the /me cache.
   */
  adoptTokens: (tokens: { accessToken: string; refreshToken: string }) => Promise<void>;
  refreshMe: () => Promise<void>;
  logout: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(() => !!getStoredTokens());
  const [role, setRole] = useState<string | null>(null);
  const [memberId, setMemberId] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [user, setUser] = useState<MeUser | null>(null);
  const [wizardStep, setWizardStep] = useState<"connect" | "create_agent" | "completed" | null>(null);

  const logout = useCallback(() => {
    clearStoredTokens();
    setIsAuthenticated(false);
    setRole(null);
    setMemberId(null);
    setAgentId(null);
    setOrganizationId(null);
    setUser(null);
    setWizardStep(null);
  }, []);

  const fetchMe = useCallback(async () => {
    try {
      const data = await api.get<MeResponse>("/me");
      setRole(data.member.role);
      setMemberId(data.member.id);
      setAgentId(data.member.agentId);
      setOrganizationId(data.member.organizationId);
      setUser(data.user ?? null);
      const nextStep = data.wizard?.step ?? null;
      setWizardStep(nextStep);
      // Drop the join-path flag once onboarding is complete so a later
      // incomplete state (e.g. user deletes their client) doesn't reuse a
      // stale "you've joined {team}" headline that no longer fits.
      if (nextStep === "completed") clearOnboardingJoinPath();
    } catch {
      // If /me fails, role stays null — UI falls back to hiding admin features
    }
  }, []);

  const login = useCallback(
    async (username: string, password: string) => {
      const tokens = await loginApi(username, password);
      setStoredTokens({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
      setIsAuthenticated(true);
      await fetchMe();
    },
    [fetchMe],
  );

  const adoptTokens = useCallback(
    async (tokens: { accessToken: string; refreshToken: string }) => {
      setStoredTokens(tokens);
      setIsAuthenticated(true);
      await fetchMe();
    },
    [fetchMe],
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
    <AuthContext.Provider
      value={{
        isAuthenticated,
        role,
        memberId,
        agentId,
        organizationId,
        user,
        wizardStep,
        login,
        adoptTokens,
        refreshMe: fetchMe,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
