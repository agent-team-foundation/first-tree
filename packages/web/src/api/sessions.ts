import type { SessionState } from "@agent-team-foundation/first-tree-hub-shared";
import { api, withOrg } from "./client.js";

export type SessionListItem = {
  agentId: string;
  chatId: string;
  state: string;
  runtimeState: string | null;
  startedAt: string;
  lastActivityAt: string;
  messageCount: number;
  summary: string | null;
  topic: string | null;
};

export const sessionQueryKey = (agentId: string, chatId: string) => ["session", agentId, chatId] as const;
export const agentSessionsQueryKey = (agentId: string) => ["agent-sessions", agentId] as const;

export type SessionListResponse = {
  items: SessionListItem[];
  nextCursor: string | null;
};

export type ToolCallEventPayload = {
  toolUseId: string;
  name: string;
  args: unknown;
  status: "pending" | "ok" | "error";
  durationMs?: number;
  resultPreview?: string;
};

export type ErrorEventPayload = {
  source: "sdk" | "runtime" | "tool";
  message: string;
};

export type AssistantTextEventPayload = {
  text: string;
};

export type TurnEndEventPayload = {
  status: "success" | "error";
};

export type SessionEventKind =
  | "tool_call"
  | "error"
  | "assistant_text"
  | "thinking"
  | "turn_end"
  | "context_tree_usage";

export type SessionEventRow = {
  id: string;
  agentId: string;
  chatId: string;
  seq: number;
  kind: SessionEventKind;
  payload: unknown;
  createdAt: string;
};

export function asToolCallPayload(payload: unknown): ToolCallEventPayload | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.toolUseId !== "string" || typeof p.name !== "string") return null;
  if (p.status !== "pending" && p.status !== "ok" && p.status !== "error") return null;
  return {
    toolUseId: p.toolUseId,
    name: p.name,
    args: p.args,
    status: p.status,
    durationMs: typeof p.durationMs === "number" ? p.durationMs : undefined,
    resultPreview: typeof p.resultPreview === "string" ? p.resultPreview : undefined,
  };
}

export function asErrorPayload(payload: unknown): ErrorEventPayload | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (p.source !== "sdk" && p.source !== "runtime" && p.source !== "tool") return null;
  if (typeof p.message !== "string") return null;
  return { source: p.source, message: p.message };
}

export function asAssistantTextPayload(payload: unknown): AssistantTextEventPayload | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.text !== "string") return null;
  return { text: p.text };
}

export function asTurnEndPayload(payload: unknown): TurnEndEventPayload | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (p.status !== "success" && p.status !== "error") return null;
  return { status: p.status };
}

export type SessionEventsResponse = {
  items: SessionEventRow[];
  nextCursor: number | null;
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
  return api.get<SessionListResponse>(withOrg(`/sessions${query ? `?${query}` : ""}`));
}

export function listAgentSessions(
  agentId: string,
  filters?: { state?: string; runtimeState?: string },
): Promise<SessionListItem[]> {
  const qs = new URLSearchParams();
  if (filters?.state) qs.set("state", filters.state);
  if (filters?.runtimeState) qs.set("runtimeState", filters.runtimeState);
  const query = qs.toString();
  return api.get<SessionListItem[]>(`/agents/${agentId}/sessions${query ? `?${query}` : ""}`);
}

export function getSession(agentId: string, chatId: string): Promise<SessionListItem> {
  return api.get<SessionListItem>(`/agents/${agentId}/sessions/${chatId}`);
}

export function listSessionEvents(
  agentId: string,
  chatId: string,
  params?: { limit?: number; cursor?: number; direction?: "asc" | "desc" },
): Promise<SessionEventsResponse> {
  const qs = new URLSearchParams();
  if (params?.limit !== undefined) qs.set("limit", String(params.limit));
  if (params?.cursor !== undefined) qs.set("cursor", String(params.cursor));
  if (params?.direction) qs.set("direction", params.direction);
  const query = qs.toString();
  return api.get<SessionEventsResponse>(`/agents/${agentId}/sessions/${chatId}/events${query ? `?${query}` : ""}`);
}

export type SessionMutationResponse = {
  agentId: string;
  chatId: string;
  state: SessionState;
  transitioned: boolean;
};

export function suspendSession(agentId: string, chatId: string): Promise<SessionMutationResponse> {
  return api.post<SessionMutationResponse>(`/agents/${agentId}/sessions/${chatId}/suspend`);
}

export function terminateSession(agentId: string, chatId: string): Promise<SessionMutationResponse> {
  return api.post<SessionMutationResponse>(`/agents/${agentId}/sessions/${chatId}/terminate`);
}
