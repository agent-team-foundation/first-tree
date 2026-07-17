import type {
  AgentType,
  ClientCapabilities,
  ConnectTokenResponse,
  ProviderModelCatalog,
  RuntimeAuthMethod,
  RuntimeProvider,
  UpdateAttempt,
} from "@first-tree/shared";
import { api, withOrg } from "./client.js";

export type { AgentType, ConnectTokenResponse };

export type RuntimeAgent = {
  agentId: string;
  clientId: string | null;
  runtimeType: string | null;
  runtimeState: string | null;
  activeSessions: number | null;
  totalSessions: number | null;
  runtimeUpdatedAt: string | null;
  type: AgentType | null;
  /** True iff the caller's member is the agent's `managerId`. Server-derived;
   *  the client never receives raw `managerId`. Used by the workspace
   *  new-chat view to seed the default chip from agents the caller
   *  personally manages. */
  managedByMe: boolean;
};

export type ActivityOverview = {
  total: number;
  running: number;
  byState: {
    idle: number;
    working: number;
    blocked: number;
    error: number;
  };
  clients: number;
  agents: RuntimeAgent[];
};

export type HubClient = {
  id: string;
  userId: string | null;
  status: "connected" | "disconnected" | "retired";
  /** Server-derived from offline duration vs refresh-token TTL. See clientAuthStateSchema in shared. */
  authState: "ok" | "expired";
  /** Channel-aware CLI binary name returned by the server. */
  binName: string;
  sdkVersion: string | null;
  serverCommandVersion?: string | null;
  hostname: string | null;
  os: string | null;
  agentCount: number;
  connectedAt: string | null;
  lastSeenAt: string;
  /**
   * Runtime-provider capability snapshot. Empty object when the client
   * has never reported any (fresh machine, pre-capability-probe SDK).
   * Consumed by the client-side pill derivation in
   * `pages/clients/derive-status.ts` to distinguish Ready
   * (≥1 capability `state=ok`) from Setup incomplete (all `≠ ok`).
   */
  capabilities: ClientCapabilities;
  /**
   * Outcome of the client's last self-update attempt, persisted by the
   * server into `clients.metadata.lastUpdateAttempt` and returned by
   * `/me/clients` and `/orgs/:orgId/clients`. A `failed` / `blocked`
   * result means the machine is stuck on an old version and needs admin
   * attention even while it's otherwise connected — see
   * `teamNeedsAttention` in `pages/clients/derive-status.ts`.
   */
  lastUpdateAttempt?: UpdateAttempt | null;
};

export function retireClient(clientId: string): Promise<void> {
  return api.delete<void>(`/clients/${encodeURIComponent(clientId)}`);
}

export function getActivityOverview(): Promise<ActivityOverview> {
  return api.get<ActivityOverview>(withOrg("/activity"));
}

export function listClients(): Promise<HubClient[]> {
  return api.get<HubClient[]>("/me/clients");
}

/**
 * Admin-only listing of every client registered in the current organization.
 * Used by the Computers page when the viewer is an admin so they can see
 * teammates' computers alongside their own. The server endpoint already
 * returns `userId` + `lastSeenAt`, which is what powers the client-side
 * "Your computers" / "Team computers" split.
 */
export function listOrgClients(): Promise<HubClient[]> {
  return api.get<HubClient[]>(withOrg("/clients"));
}

export function getClient(clientId: string): Promise<HubClient> {
  return api.get<HubClient>(`/clients/${clientId}`);
}

/**
 * Fetch this client's reported runtime-provider capabilities via the
 * single-row endpoint. Returns the same `HubClient` shape as
 * {@link listClients}; the dedicated endpoint stays as a force-refresh
 * path for surfaces that want the freshest capability state immediately
 * after a UX action (e.g. onboarding waits for the first probe).
 */
export function getClientCapabilities(clientId: string): Promise<HubClient> {
  return api.get<HubClient>(`/clients/${clientId}`);
}

export function disconnectClient(clientId: string): Promise<{ disconnected: boolean; agentIds: string[] }> {
  return api.post(`/clients/${clientId}/disconnect`);
}

/**
 * Start an in-product runtime-auth login on this client's daemon (the
 * "Connect <provider>" action). The server forwards a command to the daemon,
 * which runs the provider's official browser-OAuth login and surfaces progress
 * by re-PATCHing capabilities — so the caller just polls {@link listClients} /
 * {@link getClientCapabilities} afterwards and reads `entry.pendingAuth` then
 * the flipped `state`.
 */
export function startRuntimeAuth(
  clientId: string,
  body: { provider: RuntimeProvider; method?: RuntimeAuthMethod },
): Promise<{ ref: string; started: true }> {
  return api.post(`/clients/${encodeURIComponent(clientId)}/runtime-auth/start`, body);
}

/**
 * Ask the connected computer's daemon for the host-local model catalog for
 * this provider (Cursor `agent models`, Kimi `~/.kimi-code/config.toml`, …).
 */
export function getProviderModels(clientId: string, provider: RuntimeProvider): Promise<ProviderModelCatalog> {
  return api.get(
    `/clients/${encodeURIComponent(clientId)}/providers/${encodeURIComponent(provider)}/models`,
  );
}

export function resetAgentActivity(agentId: string): Promise<{ reset: boolean }> {
  // The agent uuid in the path is enough for the server to resolve the
  // owning org — no `withOrg` needed.
  return api.post(`/agents/${encodeURIComponent(agentId)}/reset-activity`);
}

export function generateConnectToken(): Promise<ConnectTokenResponse> {
  return api.post<ConnectTokenResponse>("/me/connect-tokens");
}
