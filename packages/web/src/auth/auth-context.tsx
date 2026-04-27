import type { WorkspaceListItem } from "@agent-team-foundation/first-tree-hub-shared";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { login as loginApi } from "../api/auth.js";
import { api, clearStoredTokens, getStoredTokens, setStoredTokens } from "../api/client.js";
import { listMyWorkspaces, switchOrganization as switchOrgApi } from "../api/workspaces.js";

type MeResponse = {
  member: { id: string; role: string; agentId: string };
};

type AuthContextValue = {
  /** Token pair present in storage. Doesn't say anything about whether the user has a workspace. */
  isAuthenticated: boolean;
  /**
   * `true` when the stored token is a `type:"user"` JWT — sign-in succeeded
   * but the user has no workspace yet. The router uses this to send the
   * caller to `/setup` instead of the regular app shell. Distinct from
   * `isAuthenticated` so we don't conflate "no token at all" with
   * "token but no workspace".
   */
  isRootless: boolean;
  /** Workspaces this user belongs to. `null` until the first fetch lands. */
  workspaces: WorkspaceListItem[] | null;
  /** Per-org member context. `null` when the token is rootless. */
  role: string | null;
  memberId: string | null;
  agentId: string | null;
  organizationId: string | null;
  /** Legacy username + password sign-in. Self-host path. */
  login: (username: string, password: string) => Promise<void>;
  /**
   * Persist a token pair issued by the OAuth callback / workspace create /
   * workspace join flow, then refresh the in-memory state. Caller is
   * responsible for navigating after this resolves.
   */
  signInWithTokens: (tokens: { accessToken: string; refreshToken: string }) => Promise<void>;
  /** Re-issue tokens scoped to a different workspace the caller belongs to. */
  switchWorkspace: (organizationId: string) => Promise<void>;
  /** Force-refresh the workspaces list (after create / join). */
  refetchWorkspaces: () => Promise<void>;
  logout: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(() => !!getStoredTokens());
  const [isRootless, setIsRootless] = useState(false);
  const [role, setRole] = useState<string | null>(null);
  const [memberId, setMemberId] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceListItem[] | null>(null);

  const logout = useCallback(() => {
    clearStoredTokens();
    setIsAuthenticated(false);
    setIsRootless(false);
    setRole(null);
    setMemberId(null);
    setAgentId(null);
    setOrganizationId(null);
    setWorkspaces(null);
  }, []);

  /**
   * Refresh in-memory state from the server. Order matters:
   *   1. /me/workspaces — works for both rootless and per-org tokens.
   *   2. If list is empty → rootless. Skip /me, set rootless flag, done.
   *   3. List non-empty → fetch /me for member context.
   *
   * We MUST NOT call `/me` while rootless: the per-route memberAuthHook
   * 401s on `type:"user"` tokens; the API client refreshes (also rootless)
   * and re-tries; the second 401 trips `clearStoredTokens` + dispatches
   * `auth:logout`, killing the otherwise-valid session. Filtering by the
   * workspaces-list result avoids the loop.
   */
  const refetchAll = useCallback(async () => {
    let list: WorkspaceListItem[];
    try {
      list = await listMyWorkspaces();
    } catch {
      // /me/workspaces failure is the only signal that the token itself
      // is dead — bail to logout via the standard auth:logout cascade.
      setWorkspaces([]);
      return;
    }
    setWorkspaces(list);
    const first = list[0];
    setOrganizationId(first?.organizationId ?? null);

    if (list.length === 0) {
      setIsRootless(true);
      setRole(null);
      setMemberId(null);
      setAgentId(null);
      return;
    }

    setIsRootless(false);
    try {
      const data = await api.get<MeResponse>("/me");
      setRole(data.member.role);
      setMemberId(data.member.id);
      setAgentId(data.member.agentId);
    } catch {
      // /me failed despite memberships existing — leave member state null
      // and let the caller decide (typical case: token's organizationId
      // points at a workspace the user was just removed from). The UI
      // can offer a switch-org prompt against the live workspaces list.
      setRole(null);
      setMemberId(null);
      setAgentId(null);
    }
  }, []);

  const refetchWorkspaces = refetchAll;

  const login = useCallback(
    async (username: string, password: string) => {
      const tokens = await loginApi(username, password);
      setStoredTokens({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
      setIsAuthenticated(true);
      await refetchAll();
    },
    [refetchAll],
  );

  const signInWithTokens = useCallback(
    async (tokens: { accessToken: string; refreshToken: string }) => {
      setStoredTokens(tokens);
      setIsAuthenticated(true);
      await refetchAll();
    },
    [refetchAll],
  );

  const switchWorkspace = useCallback(
    async (orgId: string) => {
      const tokens = await switchOrgApi({ organizationId: orgId });
      setStoredTokens(tokens);
      await refetchAll();
    },
    [refetchAll],
  );

  // First mount: if tokens are already stored, hydrate identity + workspaces.
  useEffect(() => {
    if (isAuthenticated && workspaces === null) {
      void refetchAll();
    }
  }, [isAuthenticated, workspaces, refetchAll]);

  // Listen for auth failure dispatched by the API client. The client only
  // dispatches `auth:logout` when refresh ALSO fails — by that point the
  // session is genuinely dead, so we drop everything.
  useEffect(() => {
    const handler = () => logout();
    window.addEventListener("auth:logout", handler);
    return () => window.removeEventListener("auth:logout", handler);
  }, [logout]);

  return (
    <AuthContext.Provider
      value={{
        isAuthenticated,
        isRootless,
        workspaces,
        role,
        memberId,
        agentId,
        organizationId,
        login,
        signInWithTokens,
        switchWorkspace,
        refetchWorkspaces,
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
