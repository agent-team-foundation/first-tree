import type { AgentToken, AgentTokenCreated, CreateAgentToken } from "@first-tree-core/shared";
import { api } from "./client.js";

export function listTokens(agentId: string): Promise<AgentToken[]> {
  return api.get<AgentToken[]>(`/admin/agents/${encodeURIComponent(agentId)}/tokens`);
}

export function createToken(agentId: string, data: CreateAgentToken): Promise<AgentTokenCreated> {
  return api.post<AgentTokenCreated>(`/admin/agents/${encodeURIComponent(agentId)}/tokens`, data);
}

export function revokeToken(agentId: string, tokenId: string): Promise<void> {
  return api.delete<void>(`/admin/agents/${encodeURIComponent(agentId)}/tokens/${encodeURIComponent(tokenId)}`);
}
