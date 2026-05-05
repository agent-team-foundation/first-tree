import type { MeMembership } from "@agent-team-foundation/first-tree-hub-shared";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { login as loginApi } from "../api/auth.js";
import {
  api,
  clearStoredTokens,
  getStoredTokens,
  setApiSelectedOrganizationId,
  setStoredTokens,
} from "../api/client.js";
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
  memberships?: MeMembership[];
  wizard?: { step: "connect" | "create_agent" | "completed" };
};

type AuthContextValue = {
  isAuthenticated: boolean;
  user: MeUser | null;
  memberships: MeMembership[];
  /**
   * Currently selected membership — drives `organizationId / memberId / role
   * / agentId` and the admin gate. Initialized from
   * `localStorage.selectedOrganizationId`; falls back to the first active
   * membership returned by `/me`.
   */
  currentMembership: MeMembership | null;
  organizationId: string | null;
  memberId: string | null;
  role: string | null;
  agentId: string | null;
  wizardStep: "connect" | "create_agent" | "completed" | null;
  login: (username: string, password: string) => Promise<void>;
  /**
   * Adopt a token pair handed in from a non-login surface (OAuth fragment
   * consumer, accept-invite). Mirrors what `login` does after the API call:
   * persist tokens + warm the /me cache.
   */
  adoptTokens: (tokens: { accessToken: string; refreshToken: string }) => Promise<void>;
  /**
   * Switch the active organization view. Validates server-side via
   * `POST /auth/switch-org` (204 on success) and updates
   * `localStorage.selectedOrganizationId`. Does NOT re-issue tokens or
   * touch the WS connection (decouple-client-from-identity §4.6).
   */
  selectOrganization: (organizationId: string) => Promise<void>;
  refreshMe: () => Promise<void>;
  logout: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

const SELECTED_ORG_KEY = "first-tree-hub:selectedOrganizationId";

function readSelectedOrgId(): string | null {
  try {
    return localStorage.getItem(SELECTED_ORG_KEY);
  } catch {
    return null;
  }
}

function writeSelectedOrgId(value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(SELECTED_ORG_KEY);
    else localStorage.setItem(SELECTED_ORG_KEY, value);
  } catch {
    // localStorage may be denied in private mode — ignore.
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [isAuthenticated, setIsAuthenticated] = useState(() => !!getStoredTokens());
  const [user, setUser] = useState<MeUser | null>(null);
  const [memberships, setMemberships] = useState<MeMembership[]>([]);
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(() => {
    const init = readSelectedOrgId();
    // Sync the API client's module-level override on first paint so the
    // first wave of requests (made before fetchMe resolves) already carries
    // the correct `?organizationId=` query (codex P1 #2 fix).
    setApiSelectedOrganizationId(init);
    return init;
  });
  // Fallback for legacy `/me` shape (no `memberships` array yet) — mirror
  // the single-member object so the UI keeps functioning during a partial
  // rollout where the server is older than this build.
  const [legacyMember, setLegacyMember] = useState<{
    id: string;
    role: string;
    agentId: string;
    organizationId: string;
  } | null>(null);
  const [wizardStep, setWizardStep] = useState<"connect" | "create_agent" | "completed" | null>(null);

  const logout = useCallback(() => {
    clearStoredTokens();
    writeSelectedOrgId(null);
    setApiSelectedOrganizationId(null);
    queryClient.clear();
    setIsAuthenticated(false);
    setUser(null);
    setMemberships([]);
    setSelectedOrgId(null);
    setLegacyMember(null);
    setWizardStep(null);
  }, [queryClient]);

  const fetchMe = useCallback(async () => {
    try {
      const data = await api.get<MeResponse>("/me");
      setUser(data.user ?? null);
      setLegacyMember(data.member);
      const ms = data.memberships ?? [];
      setMemberships(ms);
      const nextStep = data.wizard?.step ?? null;
      setWizardStep(nextStep);
      // Drop the join-path flag once onboarding is complete so a later
      // incomplete state (e.g. user deletes their client) doesn't reuse a
      // stale "you've joined {team}" headline that no longer fits.
      if (nextStep === "completed") clearOnboardingJoinPath();

      // Reconcile selectedOrgId with the server's view: if the stored
      // value points at an org the user no longer belongs to (left team,
      // org dissolved), fall through to the JWT default member, then to
      // the first active membership.
      setSelectedOrgId((prev) => {
        const valid = prev && ms.some((m) => m.organizationId === prev) ? prev : null;
        if (valid) {
          // Ensure the api-client override stays in sync with React state on
          // the post-/me reconcile path (no-op when prev was already valid).
          setApiSelectedOrganizationId(valid);
          return valid;
        }
        const fallback = data.member.organizationId ?? ms[0]?.organizationId ?? null;
        writeSelectedOrgId(fallback);
        setApiSelectedOrganizationId(fallback);
        return fallback;
      });
    } catch {
      // If /me fails, the UI falls back to hiding admin features.
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

  const selectOrganization = useCallback(
    async (organizationId: string) => {
      // Server-side authorization probe: 204 on active member, 403 otherwise.
      // The server no longer issues new tokens for switch-org — auth state is
      // derived from /me + localStorage on the client.
      await api.post<void>("/auth/switch-org", { organizationId });
      writeSelectedOrgId(organizationId);
      setApiSelectedOrganizationId(organizationId);
      // Drop every cached React Query result keyed off the previous org —
      // the next render refetches with the new `?organizationId=` query so
      // a non-default org never reuses the JWT default's data (codex P1 #2).
      // Cleared *before* setSelectedOrgId so the subscriber refetch fires
      // against the new override.
      queryClient.clear();
      setSelectedOrgId(organizationId);
      await fetchMe();
    },
    [fetchMe, queryClient],
  );

  // Fetch member info on initial load if already authenticated
  useEffect(() => {
    if (isAuthenticated && !user) {
      fetchMe();
    }
  }, [isAuthenticated, user, fetchMe]);

  // Listen for auth failure dispatched by the API client
  useEffect(() => {
    const handler = () => logout();
    window.addEventListener("auth:logout", handler);
    return () => window.removeEventListener("auth:logout", handler);
  }, [logout]);

  const currentMembership = useMemo<MeMembership | null>(() => {
    if (memberships.length > 0) {
      const match = memberships.find((m) => m.organizationId === selectedOrgId);
      if (match) return match;
      return memberships[0] ?? null;
    }
    // Legacy fallback: a server without `memberships` still returns `member`.
    if (legacyMember) {
      const role: MeMembership["role"] = legacyMember.role === "admin" ? "admin" : "member";
      return {
        id: legacyMember.id,
        organizationId: legacyMember.organizationId,
        organizationName: "",
        role,
        agentId: legacyMember.agentId,
      };
    }
    return null;
  }, [memberships, selectedOrgId, legacyMember]);

  return (
    <AuthContext.Provider
      value={{
        isAuthenticated,
        user,
        memberships,
        currentMembership,
        organizationId: currentMembership?.organizationId ?? null,
        memberId: currentMembership?.id ?? null,
        role: currentMembership?.role ?? null,
        agentId: currentMembership?.agentId ?? null,
        wizardStep,
        login,
        adoptTokens,
        selectOrganization,
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
