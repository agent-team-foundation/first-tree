import { api } from "./client.js";

export type RuntimeAgent = {
  agentId: string;
  clientId: string | null;
  runtimeType: string | null;
  runtimeState: string | null;
  activeSessions: number | null;
  totalSessions: number | null;
  runtimeUpdatedAt: string | null;
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
  return api.delete<void>(`/admin/clients/${encodeURIComponent(clientId)}`);
}

export function getActivityOverview(): Promise<ActivityOverview> {
  return api.get<ActivityOverview>("/admin/agents/activity");
}

export function listClients(): Promise<HubClient[]> {
  return api.get<HubClient[]>("/admin/clients");
}

export function getClient(clientId: string): Promise<HubClient> {
  return api.get<HubClient>(`/admin/clients/${clientId}`);
}

export function disconnectClient(clientId: string): Promise<{ disconnected: boolean; agentIds: string[] }> {
  return api.post(`/admin/clients/${clientId}/disconnect`);
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
