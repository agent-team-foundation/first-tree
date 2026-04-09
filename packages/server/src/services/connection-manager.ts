import type { WebSocket } from "ws";

/** WS close code: agent already connected from another client. */
export const WS_CLOSE_ALREADY_CONNECTED = 4009;

/** Track active WS connections per agentId. At most one entry per agent. */
const activeConnections = new Map<string, WebSocket>();

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
export function forceDisconnect(agentId: string): boolean {
  const ws = activeConnections.get(agentId);
  if (!ws) return false;
  ws.close(WS_CLOSE_ALREADY_CONNECTED, "Disconnected by admin");
  activeConnections.delete(agentId);
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

export function bindAgentToClient(clientId: string, agentId: string): void {
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
}

export function unbindAgentFromClient(agentId: string): void {
  const clientId = agentToClient.get(agentId);
  if (clientId) {
    const entry = clientConnections.get(clientId);
    if (entry) {
      entry.agentIds.delete(agentId);
    }
    agentToClient.delete(agentId);
  }
  activeConnections.delete(agentId);
}

export function getClientAgentIds(clientId: string): string[] {
  const entry = clientConnections.get(clientId);
  return entry ? [...entry.agentIds] : [];
}

export function getAgentClientId(agentId: string): string | undefined {
  return agentToClient.get(agentId);
}

export function removeClientConnection(clientId: string, ws: WebSocket): string[] {
  const entry = clientConnections.get(clientId);
  if (!entry || entry.ws !== ws) return [];

  const agentIds = [...entry.agentIds];
  for (const agentId of agentIds) {
    agentToClient.delete(agentId);
    activeConnections.delete(agentId);
  }
  clientConnections.delete(clientId);
  return agentIds;
}

export function forceDisconnectClient(clientId: string): string[] {
  const entry = clientConnections.get(clientId);
  if (!entry) return [];

  const agentIds = [...entry.agentIds];
  entry.ws.close(WS_CLOSE_ALREADY_CONNECTED, "Client disconnected by admin");

  for (const agentId of agentIds) {
    agentToClient.delete(agentId);
    activeConnections.delete(agentId);
  }
  clientConnections.delete(clientId);
  return agentIds;
}
