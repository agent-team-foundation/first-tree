import { randomBytes } from "node:crypto";
import type { WebSocket } from "ws";

/** WS close code: agent already connected from another client. */
export const WS_CLOSE_ALREADY_CONNECTED = 4009;

/** Track active WS connections per agentId. At most one entry per agent. */
const activeConnections = new Map<string, WebSocket>();

export type AgentRuntimeSessionBinding = {
  clientId: string;
  runtimeSessionToken: string;
};

const agentRuntimeSessions = new Map<string, AgentRuntimeSessionBinding>();

function mintRuntimeSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Check if an agent already has an active WS connection. */
export function hasActiveConnection(agentId: string): boolean {
  const ws = activeConnections.get(agentId);
  return ws !== undefined && ws.readyState <= 1;
}

/** Register a WS connection for an agent. */
export function setConnection(agentId: string, ws: WebSocket): void {
  activeConnections.set(agentId, ws);
}

/** Remove a WS connection if it matches the registered one. Returns true if removed. */
export function removeConnection(agentId: string, ws: WebSocket): boolean {
  if (activeConnections.get(agentId) === ws) {
    activeConnections.delete(agentId);
    return true;
  }
  return false;
}

/** Force-disconnect an agent's active WS connection. Returns true if a connection was closed. */
export function forceDisconnect(agentId: string, reason?: string, expectedClientId?: string): boolean {
  const clientId = agentToClient.get(agentId);
  if (expectedClientId !== undefined && clientId !== expectedClientId) return false;
  if (clientId) {
    // M1 mode: unbind the single agent without closing the shared client WS
    const entry = clientConnections.get(clientId);
    if (entry && entry.ws.readyState <= 1) {
      entry.ws.send(JSON.stringify({ type: "agent:force_disconnect", agentId, ...(reason ? { reason } : {}) }));
    }
    unbindAgentFromClient(agentId, clientId);
    return true;
  }

  // Legacy mode: close the per-agent WS
  const ws = activeConnections.get(agentId);
  if (!ws) return false;
  ws.close(WS_CLOSE_ALREADY_CONNECTED, "Disconnected by admin");
  activeConnections.delete(agentId);
  agentRuntimeSessions.delete(agentId);
  return true;
}

// -- M1: Per-client connections (one WS per client, multiple agents) --

type ClientEntry = {
  ws: WebSocket;
  agentIds: Set<string>;
};

const clientConnections = new Map<string, ClientEntry>();
const agentToClient = new Map<string, string>();

export function setClientConnection(clientId: string, ws: WebSocket): void {
  const existing = clientConnections.get(clientId);
  if (existing && existing.ws !== ws && existing.ws.readyState <= 1) {
    // Close the previous connection to prevent clientId takeover
    existing.ws.close(WS_CLOSE_ALREADY_CONNECTED, "Replaced by new connection");
    // Clean up agent bindings from the old connection
    for (const agentId of existing.agentIds) {
      agentToClient.delete(agentId);
      agentRuntimeSessions.delete(agentId);
      activeConnections.delete(agentId);
    }
  }
  clientConnections.set(clientId, { ws, agentIds: new Set() });
}

export function getClientConnection(clientId: string): WebSocket | undefined {
  const entry = clientConnections.get(clientId);
  return entry?.ws.readyState === 1 ? entry.ws : undefined;
}

export function hasClientConnection(clientId: string): boolean {
  const entry = clientConnections.get(clientId);
  return entry !== undefined && entry.ws.readyState <= 1;
}

export function bindAgentToClient(
  clientId: string,
  agentId: string,
  runtimeSessionToken = mintRuntimeSessionToken(),
): string {
  // Remove agent from previous client if it was bound elsewhere
  const prevClientId = agentToClient.get(agentId);
  if (prevClientId && prevClientId !== clientId) {
    const prevEntry = clientConnections.get(prevClientId);
    if (prevEntry) {
      prevEntry.agentIds.delete(agentId);
    }
  }

  const entry = clientConnections.get(clientId);
  if (entry) {
    entry.agentIds.add(agentId);
    activeConnections.set(agentId, entry.ws);
  }
  agentToClient.set(agentId, clientId);
  agentRuntimeSessions.set(agentId, { clientId, runtimeSessionToken });
  return runtimeSessionToken;
}

export function unbindAgentFromClient(agentId: string, expectedClientId?: string): boolean {
  const clientId = agentToClient.get(agentId);
  if (expectedClientId !== undefined && clientId !== expectedClientId) return false;
  if (clientId) {
    const entry = clientConnections.get(clientId);
    if (entry) {
      entry.agentIds.delete(agentId);
    }
    agentToClient.delete(agentId);
  }
  activeConnections.delete(agentId);
  agentRuntimeSessions.delete(agentId);
  return clientId !== undefined;
}

export function getClientAgentIds(clientId: string): string[] {
  const entry = clientConnections.get(clientId);
  return entry ? [...entry.agentIds] : [];
}

export function getAgentClientId(agentId: string): string | undefined {
  return agentToClient.get(agentId);
}

export function getAgentRuntimeSession(agentId: string): AgentRuntimeSessionBinding | undefined {
  const binding = agentRuntimeSessions.get(agentId);
  if (!binding) return undefined;
  const entry = clientConnections.get(binding.clientId);
  if (!entry || entry.ws.readyState !== 1) return undefined;
  return binding;
}

export function validateAgentRuntimeSession(agentId: string, clientId: string, token: string): boolean {
  const binding = getAgentRuntimeSession(agentId);
  return binding?.clientId === clientId && binding.runtimeSessionToken === token;
}

export function removeClientConnection(clientId: string, ws: WebSocket): string[] {
  const entry = clientConnections.get(clientId);
  if (!entry || entry.ws !== ws) return [];

  const agentIds = [...entry.agentIds];
  for (const agentId of agentIds) {
    agentToClient.delete(agentId);
    agentRuntimeSessions.delete(agentId);
    activeConnections.delete(agentId);
  }
  clientConnections.delete(clientId);
  rejectPendingRepliesForClient(clientId, new Error("Client disconnected"));
  return agentIds;
}

/**
 * Was `ws` the socket currently registered as `clientId`'s active connection
 * at the time of the call? Used by ws-client.ts's `socket.on("close")` to
 * decide whether to write `clients.status='disconnected'` to the DB — when a
 * fast reconnect happens, the new socket has already swapped itself in via
 * `setClientConnection`, so the old socket's late-arriving onClose must NOT
 * stamp the row back to disconnected.
 *
 * The check is "this socket equals the registered ws", not "this socket is
 * still OPEN" — the close handler runs precisely when the socket is no
 * longer OPEN, but the in-memory entry might still legitimately point at
 * us if no new connection has taken over yet.
 */
export function isActiveClientConnection(clientId: string, ws: WebSocket): boolean {
  const entry = clientConnections.get(clientId);
  return entry?.ws === ws;
}

/** Send a message to a client's WebSocket. Returns true if delivered. */
export function sendToClient(clientId: string, message: Record<string, unknown>): boolean {
  const entry = clientConnections.get(clientId);
  if (!entry || entry.ws.readyState !== 1) return false;
  entry.ws.send(JSON.stringify(message));
  return true;
}

/** Send a message to a specific agent via its client's WebSocket. Returns true if delivered. */
export function sendToAgent(agentId: string, message: Record<string, unknown>): boolean {
  const clientId = agentToClient.get(agentId);
  if (!clientId) return false;

  const entry = clientConnections.get(clientId);
  if (!entry || entry.ws.readyState !== 1) return false;

  entry.ws.send(JSON.stringify({ ...message, agentId }));
  return true;
}

export function forceDisconnectClient(clientId: string): string[] {
  const entry = clientConnections.get(clientId);
  if (!entry) return [];

  const agentIds = [...entry.agentIds];
  entry.ws.close(WS_CLOSE_ALREADY_CONNECTED, "Client disconnected by admin");

  for (const agentId of agentIds) {
    agentToClient.delete(agentId);
    agentRuntimeSessions.delete(agentId);
    activeConnections.delete(agentId);
  }
  clientConnections.delete(clientId);
  rejectPendingRepliesForClient(clientId, new Error("Client disconnected"));
  return agentIds;
}

/**
 * HTTP→daemon request/response correlation. Used by host-local discovery
 * (provider model catalogs) where the web needs a synchronous answer from the
 * connected computer rather than fire-and-forget + poll.
 */
type PendingClientReply = {
  clientId: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const pendingClientReplies = new Map<string, PendingClientReply>();

const DEFAULT_CLIENT_REPLY_TIMEOUT_MS = 25_000;

export function waitForClientReply(
  clientId: string,
  ref: string,
  timeoutMs: number = DEFAULT_CLIENT_REPLY_TIMEOUT_MS,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (pendingClientReplies.has(ref)) {
      reject(new Error(`Duplicate pending client reply ref: ${ref}`));
      return;
    }
    const timer = setTimeout(() => {
      pendingClientReplies.delete(ref);
      reject(new Error("Timed out waiting for the computer to reply"));
    }, timeoutMs);
    pendingClientReplies.set(ref, { clientId, resolve, reject, timer });
  });
}

export function resolveClientReply(clientId: string, ref: string, value: unknown): boolean {
  const pending = pendingClientReplies.get(ref);
  if (!pending || pending.clientId !== clientId) return false;
  clearTimeout(pending.timer);
  pendingClientReplies.delete(ref);
  pending.resolve(value);
  return true;
}

export function rejectPendingRepliesForClient(clientId: string, error: Error): void {
  for (const [ref, pending] of pendingClientReplies) {
    if (pending.clientId !== clientId) continue;
    clearTimeout(pending.timer);
    pendingClientReplies.delete(ref);
    pending.reject(error);
  }
}

/** Test seam: drop every pending reply without resolving. */
export function clearPendingClientRepliesForTests(): void {
  for (const pending of pendingClientReplies.values()) {
    clearTimeout(pending.timer);
  }
  pendingClientReplies.clear();
}
