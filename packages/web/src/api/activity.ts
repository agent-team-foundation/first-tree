import type { ClientCapabilities } from "@agent-team-foundation/first-tree-hub-shared";
import { api } from "./client.js";

export type AgentType = "human" | "personal_assistant" | "autonomous_agent";

export type RuntimeAgent = {
  agentId: string;
  clientId: string | null;
  runtimeType: string | null;
  runtimeState: string | null;
  activeSessions: number | null;
  totalSessions: number | null;
  runtimeUpdatedAt: string | null;
  type: AgentType | null;
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
  return api.get<ActivityOverview>("/admin/agents/activity");
}

export function listClients(): Promise<HubClient[]> {
  return api.get<HubClient[]>("/clients");
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
  return api.post(`/admin/agents/activity/${agentId}/reset-activity`);
}

export type ConnectTokenResponse = {
  token: string;
  expiresIn: number;
  command: string;
};

export function generateConnectToken(): Promise<ConnectTokenResponse> {
  return api.post<ConnectTokenResponse>("/connect-tokens");
}
