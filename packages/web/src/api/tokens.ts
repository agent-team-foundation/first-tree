import type { AgentToken, AgentTokenCreated, CreateAgentToken } from "@first-tree-hub/shared";
import { api } from "./client.js";

export function listTokens(uuid: string): Promise<AgentToken[]> {
  return api.get<AgentToken[]>(`/admin/agents/${encodeURIComponent(uuid)}/tokens`);
}

export function createToken(uuid: string, data: CreateAgentToken): Promise<AgentTokenCreated> {
  return api.post<AgentTokenCreated>(`/admin/agents/${encodeURIComponent(uuid)}/tokens`, data);
}

export function revokeToken(uuid: string, tokenId: string): Promise<void> {
  return api.delete<void>(`/admin/agents/${encodeURIComponent(uuid)}/tokens/${encodeURIComponent(tokenId)}`);
}
