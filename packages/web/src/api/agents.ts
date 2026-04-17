import type { Agent, CreateAgent, UpdateAgent } from "@agent-team-foundation/first-tree-hub-shared";
import { api } from "./client.js";

type PaginatedAgents = {
  items: Agent[];
  nextCursor: string | null;
};

export function listAgents(params?: { limit?: number; cursor?: string; type?: string }): Promise<PaginatedAgents> {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set("limit", String(params.limit));
  if (params?.cursor) qs.set("cursor", params.cursor);
  if (params?.type) qs.set("type", params.type);
  const query = qs.toString();
  return api.get<PaginatedAgents>(`/admin/agents${query ? `?${query}` : ""}`);
}

export function getAgent(uuid: string): Promise<Agent> {
  return api.get<Agent>(`/admin/agents/${encodeURIComponent(uuid)}`);
}

export function createAgent(data: CreateAgent): Promise<Agent> {
  return api.post<Agent>("/admin/agents", data);
}

export function updateAgent(uuid: string, data: UpdateAgent): Promise<Agent> {
  return api.patch<Agent>(`/admin/agents/${encodeURIComponent(uuid)}`, data);
}

export function deleteAgent(uuid: string): Promise<void> {
  return api.delete<void>(`/admin/agents/${encodeURIComponent(uuid)}`);
}

export function suspendAgent(uuid: string): Promise<Agent> {
  return api.post<Agent>(`/admin/agents/${encodeURIComponent(uuid)}/suspend`, {});
}

export function reactivateAgent(uuid: string): Promise<Agent> {
  return api.post<Agent>(`/admin/agents/${encodeURIComponent(uuid)}/reactivate`, {});
}

// -- Test Connection --

export type ConnectionInfo = {
  health: "connected" | "stale" | "disconnected";
  runtimeState: string | null;
  lastSeenAt: string | null;
  client: {
    id: string;
    hostname: string | null;
    os: string | null;
    sdkVersion: string | null;
    connectedAt: string | null;
  } | null;
};

export type TestResult = {
  status: "success" | "timeout" | "offline" | "stale" | "error";
  message?: string;
  chatId?: string;
  responseContent?: string;
  responseTime?: number;
  connection?: ConnectionInfo;
};

export function testAgentConnection(uuid: string): Promise<TestResult> {
  return api.post<TestResult>(`/admin/agents/${encodeURIComponent(uuid)}/test`, {});
}
