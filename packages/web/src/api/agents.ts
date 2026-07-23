import type {
  Agent,
  AgentSkills,
  CreateAgent,
  NewChatDefaultCandidatesRequest,
  NewChatDefaultCandidatesResponse,
  SwitchAgentRuntime,
  UpdateAgent,
} from "@first-tree/shared";
import { api, apiFetchRaw, withOrg } from "./client.js";

type PaginatedAgents = {
  items: Agent[];
  nextCursor: string | null;
};

export function listAgents(params?: {
  limit?: number;
  cursor?: string;
  type?: string;
  /** Case-insensitive substring match against `name` + `displayName`.
   *  Whitespace is trimmed server-side; pass a non-empty string. */
  query?: string;
  /** Restrict to identities that can be added to a new chat participant set. */
  addressableOnly?: boolean;
}): Promise<PaginatedAgents> {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set("limit", String(params.limit));
  if (params?.cursor) qs.set("cursor", params.cursor);
  if (params?.type) qs.set("type", params.type);
  if (params?.query) qs.set("query", params.query);
  if (params?.addressableOnly) qs.set("addressableOnly", "true");
  const query = qs.toString();
  return api.get<PaginatedAgents>(withOrg(`/agents${query ? `?${query}` : ""}`));
}

/**
 * Admin-only listing that bypasses the visibility filter and surfaces
 * private agents owned by other members. Used by the Team page's
 * "Other members' private agents" governance section. Server enforces
 * the admin check via {@link requireOrgMembership} + role gate.
 */
export function listAllAgents(params?: { limit?: number; cursor?: string }): Promise<PaginatedAgents> {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set("limit", String(params.limit));
  if (params?.cursor) qs.set("cursor", params.cursor);
  const query = qs.toString();
  return api.get<PaginatedAgents>(withOrg(`/agents/all${query ? `?${query}` : ""}`));
}

export function getNewChatDefaultCandidates(
  data: NewChatDefaultCandidatesRequest,
): Promise<NewChatDefaultCandidatesResponse> {
  return api.post<NewChatDefaultCandidatesResponse>(withOrg("/agents/new-chat-default-candidates"), data);
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
  /** Lifecycle status — `active` / `suspended` (deleted agents are excluded
   *  server-side). A suspended agent cannot bind/run, so callers that need a
   *  *usable* agent must filter to active. */
  status: string;
  /**
   * Resolved avatar URL: uploaded agent image if present, else — for
   * human agents — the backing user's external avatar URL (e.g. GitHub
   * `users.avatar_url`). `null` when the agent has neither source.
   */
  avatarImageUrl: string | null;
};

export function listManagedAgents(): Promise<ManagedAgent[]> {
  return api.get<ManagedAgent[]>("/me/managed-agents");
}

export function getAgent(uuid: string): Promise<Agent> {
  return api.get<Agent>(`/agents/${encodeURIComponent(uuid)}`);
}

/**
 * Read the agent's slash-command catalog. Powers the composer's `/`
 * popover after the caller `@mentions` the agent. Daemon refreshes this
 * on startup via `PATCH /agents/:uuid/skills`; web cache is per-agent so
 * switching `@mention` targets re-uses any already-fetched lists.
 */
export function getAgentSkills(uuid: string): Promise<{ skills: AgentSkills }> {
  return api.get<{ skills: AgentSkills }>(`/agents/${encodeURIComponent(uuid)}/skills`);
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

export function switchAgentRuntime(uuid: string, data: SwitchAgentRuntime): Promise<Agent> {
  return api.post<Agent>(`/agents/${encodeURIComponent(uuid)}/switch-runtime`, data);
}

export function recoverAgentRuntimeSwitch(uuid: string): Promise<Agent> {
  return api.post<Agent>(`/agents/${encodeURIComponent(uuid)}/switch-runtime/recover`, {});
}

export function deleteAgent(uuid: string): Promise<void> {
  return api.delete<void>(`/agents/${encodeURIComponent(uuid)}`);
}

/**
 * Upload a manager-selected avatar image for the agent. `blob` carries the
 * raw bytes (the caller is responsible for resizing/encoding — typically a
 * 256×256 WEBP produced via `<canvas>`). Sends `Content-Type: <mime>`
 * directly, bypassing the JSON `api` helper.
 */
export async function uploadAgentAvatar(uuid: string, blob: Blob): Promise<{ avatarImageUrl: string }> {
  const res = await apiFetchRaw(`/agents/${encodeURIComponent(uuid)}/avatar`, {
    method: "PUT",
    headers: { "Content-Type": blob.type || "application/octet-stream" },
    body: blob,
  });
  return (await res.json()) as { avatarImageUrl: string };
}

/** Clear an agent's avatar image (falls back to color + initial). */
export function deleteAgentAvatar(uuid: string): Promise<void> {
  return api.delete<void>(`/agents/${encodeURIComponent(uuid)}/avatar`);
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

/**
 * Test connection response.
 *
 * Server returns only `success` / `offline` / `stale`. The extra `error`
 * status is a client-side fallback shown when the request itself fails
 * (network drop, 403, etc.) — in that case `connection` is absent.
 */
export type TestResult = {
  status: "success" | "offline" | "stale" | "error";
  message?: string;
  connection?: ConnectionInfo;
};

export function testAgentConnection(uuid: string): Promise<TestResult> {
  return api.post<TestResult>(`/agents/${encodeURIComponent(uuid)}/test`, {});
}
