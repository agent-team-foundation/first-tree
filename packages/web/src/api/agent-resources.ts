import type { AgentResourcesOutput, UpdateAgentResources } from "@first-tree/shared";
import { api } from "./client.js";

export function getAgentResources(agentId: string): Promise<AgentResourcesOutput> {
  return api.get<AgentResourcesOutput>(`/agents/${encodeURIComponent(agentId)}/resources`);
}

export function updateAgentResources(agentId: string, body: UpdateAgentResources): Promise<AgentResourcesOutput> {
  return api.patch<AgentResourcesOutput>(`/agents/${encodeURIComponent(agentId)}/resources`, body);
}
