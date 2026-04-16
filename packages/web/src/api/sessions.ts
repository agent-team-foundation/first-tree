import { api } from "./client.js";

export type SessionListItem = {
  agentId: string;
  chatId: string;
  state: string;
  runtimeState: string | null;
  startedAt: string;
  lastActivityAt: string;
  messageCount: number;
};

export type SessionListResponse = {
  items: SessionListItem[];
  nextCursor: string | null;
};

export type SessionOutput = {
  content: string;
  updatedAt: string | null;
};

export function listSessions(params?: {
  limit?: number;
  cursor?: string;
  state?: string;
  agentId?: string;
}): Promise<SessionListResponse> {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set("limit", String(params.limit));
  if (params?.cursor) qs.set("cursor", params.cursor);
  if (params?.state) qs.set("state", params.state);
  if (params?.agentId) qs.set("agentId", params.agentId);
  const query = qs.toString();
  return api.get<SessionListResponse>(`/admin/sessions${query ? `?${query}` : ""}`);
}

export function listAgentSessions(
  agentId: string,
  filters?: { state?: string; runtimeState?: string },
): Promise<SessionListItem[]> {
  const qs = new URLSearchParams();
  if (filters?.state) qs.set("state", filters.state);
  if (filters?.runtimeState) qs.set("runtimeState", filters.runtimeState);
  const query = qs.toString();
  return api.get<SessionListItem[]>(`/admin/sessions/agents/${agentId}${query ? `?${query}` : ""}`);
}

export function getSession(agentId: string, chatId: string): Promise<SessionListItem> {
  return api.get<SessionListItem>(`/admin/sessions/agents/${agentId}/${chatId}`);
}

export function getSessionOutput(agentId: string, chatId: string): Promise<SessionOutput> {
  return api.get<SessionOutput>(`/admin/sessions/agents/${agentId}/${chatId}/output`);
}

export function suspendSession(agentId: string, chatId: string): Promise<unknown> {
  return api.post(`/admin/sessions/agents/${agentId}/${chatId}/suspend`);
}

export function resumeSession(agentId: string, chatId: string): Promise<unknown> {
  return api.post(`/admin/sessions/agents/${agentId}/${chatId}/resume`);
}

export function terminateSession(agentId: string, chatId: string): Promise<unknown> {
  return api.post(`/admin/sessions/agents/${agentId}/${chatId}/terminate`);
}
