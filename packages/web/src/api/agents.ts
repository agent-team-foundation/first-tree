import type { Agent, CreateAgent, RebindAgent, UpdateAgent } from "@agent-team-foundation/first-tree-hub-shared";
import { api, withOrg } from "./client.js";

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
  return api.get<PaginatedAgents>(withOrg(`/agents${query ? `?${query}` : ""}`));
}

/**
 * Cross-org list of every agent the caller manages — the web mirror of the
 * CLI `agent list --remote` view. Backed by `GET /me/managed-agents`, which
 * is org-free (joins `agents → members.user_id`) so it returns agents in
 * non-default orgs too.
 *
 * The Computers panel uses this as a name-resolution source for `BOUND
 * AGENTS` rows: a client is user-scoped and may host agents from multiple
 * orgs, so the org-scoped `/agents` query alone falls back to the raw
 * UUID for any agent outside the currently-selected org.
 */
export type ManagedAgent = {
  uuid: string;
  name: string | null;
  displayName: string;
  type: string;
  organizationId: string;
  inboxId: string;
  visibility: string;
  runtimeProvider: string;
  clientId: string | null;
};

export function listManagedAgents(): Promise<ManagedAgent[]> {
  return api.get<ManagedAgent[]>("/me/managed-agents");
}

export function getAgent(uuid: string): Promise<Agent> {
  return api.get<Agent>(`/agents/${encodeURIComponent(uuid)}`);
}

export function createAgent(data: CreateAgent): Promise<Agent> {
  return api.post<Agent>(withOrg("/agents"), data);
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
  return api.get<AgentNameAvailability>(withOrg(`/agents/names/${encodeURIComponent(name)}/availability`));
}

export function updateAgent(uuid: string, data: UpdateAgent): Promise<Agent> {
  return api.patch<Agent>(`/agents/${encodeURIComponent(uuid)}`, data);
}

/**
 * Re-bind an agent to a new client and/or a new runtime provider. The Hub
 * runs owner / org / capability checks atomically; pass `force: true` to
 * bypass the capability match (e.g. when the destination client is offline
 * and `clients.metadata.capabilities` is stale).
 */
export function rebindAgent(uuid: string, data: RebindAgent): Promise<Agent> {
  return api.patch<Agent>(`/agents/${encodeURIComponent(uuid)}/rebind`, data);
}

export function deleteAgent(uuid: string): Promise<void> {
  return api.delete<void>(`/agents/${encodeURIComponent(uuid)}`);
}

export function suspendAgent(uuid: string): Promise<Agent> {
  return api.post<Agent>(`/agents/${encodeURIComponent(uuid)}/suspend`, {});
}

export function reactivateAgent(uuid: string): Promise<Agent> {
  return api.post<Agent>(`/agents/${encodeURIComponent(uuid)}/reactivate`, {});
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
  return api.post<TestResult>(`/agents/${encodeURIComponent(uuid)}/test`, {});
}
