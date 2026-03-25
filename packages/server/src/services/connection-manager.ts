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
