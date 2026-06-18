import type { AgentRuntimeConfig, UpdateAgentRuntimeConfig } from "@first-tree/shared";
import { api } from "./client.js";

/**
 * Step 9: Web client for the per-agent runtime config Admin API.
 * Mirrors the endpoints exposed by `adminAgentConfigRoutes`.
 */
export function getAgentConfig(agentId: string): Promise<AgentRuntimeConfig> {
  return api.get<AgentRuntimeConfig>(`/agents/${agentId}/config`);
}

export function updateAgentConfig(agentId: string, body: UpdateAgentRuntimeConfig): Promise<AgentRuntimeConfig> {
  return api.patch<AgentRuntimeConfig>(`/agents/${agentId}/config`, body);
}

/** Step 10: client connectivity probe used by AgentConfigTab to render the offline banner. */
export type ClientStatusInfo = {
  online: boolean;
  clientId: string | null;
  offlineSince: string | null;
};
export function getAgentClientStatus(agentId: string): Promise<ClientStatusInfo> {
  return api.get<ClientStatusInfo>(`/agents/${agentId}/client-status`);
}
