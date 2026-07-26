import type { SessionState } from "@first-tree/shared";
import { api, withOrg } from "./client.js";

export type SessionListItem = {
  agentId: string;
  chatId: string;
  /** Per-(agent,chat) session lifecycle (C vocabulary). */
  state: SessionState;
  /**
   * Agent-global `agent_presence.runtime_state` copied onto every session
   * the agent owns. NOT per-session — every row for the same agent carries
   * the same value. Kept for the roster / admin views that intentionally
   * show the aggregate axis; do NOT use it as a per-session "is this chat
   * working" signal — that is what `state` (lifecycle) and `liveActivity`
   * on `MeChatRow` express.
   *
   * @deprecated for per-session UI — use `state` (lifecycle) or, on the
   * chat-list, `MeChatRow.liveActivity` (live working signal).
   */
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
  | "context_tree_usage"
  | "token_usage";

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

export type ChatSessionEventsResponse = {
  feeds: Array<SessionEventsResponse & { agentId: string }>;
};

export const chatSessionEventsQueryKey = (chatId: string) => ["chat-session-events", chatId] as const;

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

export function listChatSessionEvents(
  chatId: string,
  params?: { limit?: number; direction?: "asc" | "desc" },
): Promise<ChatSessionEventsResponse> {
  const qs = new URLSearchParams();
  if (params?.limit !== undefined) qs.set("limit", String(params.limit));
  if (params?.direction) qs.set("direction", params.direction);
  const query = qs.toString();
  return api.get<ChatSessionEventsResponse>(
    `/chats/${encodeURIComponent(chatId)}/session-events${query ? `?${query}` : ""}`,
  );
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

export function resumeSession(agentId: string, chatId: string): Promise<SessionMutationResponse> {
  return api.post<SessionMutationResponse>(`/agents/${agentId}/sessions/${chatId}/resume`);
}

export function terminateSession(agentId: string, chatId: string): Promise<SessionMutationResponse> {
  return api.post<SessionMutationResponse>(`/agents/${agentId}/sessions/${chatId}/terminate`);
}
