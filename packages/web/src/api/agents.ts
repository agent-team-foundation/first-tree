import type { Agent } from "@first-tree-hub/shared";
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

export function deleteAgent(agentId: string): Promise<void> {
  return api.delete<void>(`/admin/agents/${encodeURIComponent(agentId)}`);
}

export function suspendAgent(agentId: string): Promise<Agent> {
  return api.post<Agent>(`/admin/agents/${encodeURIComponent(agentId)}/suspend`, {});
}

export function reactivateAgent(agentId: string): Promise<Agent> {
  return api.post<Agent>(`/admin/agents/${encodeURIComponent(agentId)}/reactivate`, {});
}

// -- Test Connection --

export type TestResult = {
  status: "success" | "timeout" | "offline" | "error";
  message?: string;
  chatId?: string;
  responseContent?: string;
  responseTime?: number;
};

export function testAgentConnection(agentId: string): Promise<TestResult> {
  return api.post<TestResult>(`/admin/agents/${encodeURIComponent(agentId)}/test`, {});
}
