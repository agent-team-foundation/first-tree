import type { AgentType, AgentVisibility, ClientCapabilities } from "@first-tree/shared";
import { api, withOrg } from "./client.js";

export type { AgentType, AgentVisibility };

export type RuntimeAgent = {
  agentId: string;
  clientId: string | null;
  runtimeType: string | null;
  runtimeState: string | null;
  activeSessions: number | null;
  totalSessions: number | null;
  runtimeUpdatedAt: string | null;
  type: AgentType | null;
  /** Post-type-merge: surfaces the pre-merge `personal_assistant` vs.
   *  `autonomous_agent` distinction so the new-chat default-seed picker
   *  can still prefer the personal-assistant when there's no MRU signal. */
  visibility: AgentVisibility | null;
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
  status: string;
  /** Server-derived from offline duration vs refresh-token TTL. See clientAuthStateSchema in shared. */
  authState: "ok" | "expired";
  sdkVersion: string | null;
  hostname: string | null;
  os: string | null;
  agentCount: number;
  connectedAt: string | null;
  lastSeenAt: string;
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
 * Fetch this client's reported runtime-provider capabilities. Returns the
 * client's full row plus its `metadata.capabilities` blob (Option C). Used
 * by the Computers page to surface SDK install + auth state
 * per provider.
 */
export type ClientWithCapabilities = HubClient & {
  capabilities: ClientCapabilities;
};

export function getClientCapabilities(clientId: string): Promise<ClientWithCapabilities> {
  return api.get<ClientWithCapabilities>(`/clients/${clientId}`);
}

export function disconnectClient(clientId: string): Promise<{ disconnected: boolean; agentIds: string[] }> {
  return api.post(`/clients/${clientId}/disconnect`);
}

export function resetAgentActivity(agentId: string): Promise<{ reset: boolean }> {
  // The agent uuid in the path is enough for the server to resolve the
  // owning org — no `withOrg` needed.
  return api.post(`/agents/${encodeURIComponent(agentId)}/reset-activity`);
}

export type ConnectTokenResponse = {
  token: string;
  expiresIn: number;
  command: string;
};

export function generateConnectToken(): Promise<ConnectTokenResponse> {
  return api.post<ConnectTokenResponse>("/me/connect-tokens");
}
