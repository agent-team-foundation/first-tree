import type { Agent, CreateAgent, UpdateAgent } from "@agent-hub/shared";
import { api } from "./client.js";

type PaginatedAgents = {
  items: Agent[];
  nextCursor: string | null;
};

export function listAgents(params?: { limit?: number; cursor?: string }): Promise<PaginatedAgents> {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set("limit", String(params.limit));
  if (params?.cursor) qs.set("cursor", params.cursor);
  const query = qs.toString();
  return api.get<PaginatedAgents>(`/admin/agents${query ? `?${query}` : ""}`);
}

export function getAgent(agentId: string): Promise<Agent> {
  return api.get<Agent>(`/admin/agents/${encodeURIComponent(agentId)}`);
}

export function createAgent(data: CreateAgent): Promise<Agent> {
  return api.post<Agent>("/admin/agents", data);
}

export function updateAgent(agentId: string, data: UpdateAgent): Promise<Agent> {
  return api.patch<Agent>(`/admin/agents/${encodeURIComponent(agentId)}`, data);
}

export function deleteAgent(agentId: string): Promise<void> {
  return api.delete<void>(`/admin/agents/${encodeURIComponent(agentId)}`);
}
