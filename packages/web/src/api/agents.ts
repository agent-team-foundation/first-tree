import type { Agent, CreateAgent, RebindAgent, UpdateAgent } from "@agent-team-foundation/first-tree-hub-shared";
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

/**
 * Admin-only: every agent in the caller's org, ignoring visibility. Used by
 * the Admin → All Agents tab; the server 403s for non-admin callers.
 */
export function listAllAgentsForAdmin(params?: { limit?: number; cursor?: string }): Promise<PaginatedAgents> {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set("limit", String(params.limit));
  if (params?.cursor) qs.set("cursor", params.cursor);
  const query = qs.toString();
  return api.get<PaginatedAgents>(`/admin/agents/all${query ? `?${query}` : ""}`);
}

export function getAgent(uuid: string): Promise<Agent> {
  return api.get<Agent>(`/admin/agents/${encodeURIComponent(uuid)}`);
}

export function createAgent(data: CreateAgent): Promise<Agent> {
  return api.post<Agent>("/admin/agents", data);
}

/**
 * Probe whether an agent name is available in the caller's organization.
 *
 * The web creation dialog calls this (debounced) so the user sees collision
 * or reserved-name errors inline, before submitting. The authoritative check
 * still happens server-side on POST — this is a UX convenience only.
 */
export type AgentNameAvailability =
  | { available: true }
  | { available: false; reason: "invalid" | "reserved" | "taken" };

export function checkAgentNameAvailability(name: string): Promise<AgentNameAvailability> {
  return api.get<AgentNameAvailability>(`/admin/agents/names/${encodeURIComponent(name)}/availability`);
}

export function updateAgent(uuid: string, data: UpdateAgent): Promise<Agent> {
  return api.patch<Agent>(`/admin/agents/${encodeURIComponent(uuid)}`, data);
}

/**
 * Re-bind an agent to a new client and/or a new runtime provider. The Hub
 * runs owner / org / capability checks atomically; pass `force: true` to
 * bypass the capability match (e.g. when the destination client is offline
 * and `clients.metadata.capabilities` is stale).
 */
export function rebindAgent(uuid: string, data: RebindAgent): Promise<Agent> {
  return api.patch<Agent>(`/admin/agents/${encodeURIComponent(uuid)}/rebind`, data);
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
