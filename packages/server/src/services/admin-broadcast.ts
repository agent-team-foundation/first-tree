/** Service-layer seam for pushing payloads to admin WebSocket sockets. */

export type AdminBroadcastPayload = Record<string, unknown>;
export type AdminBroadcaster = (payload: AdminBroadcastPayload) => void;

let registered: AdminBroadcaster | null = null;

export function registerAdminBroadcaster(fn: AdminBroadcaster): void {
  registered = fn;
}

export function resetAdminBroadcaster(): void {
  registered = null;
}

export function broadcastToAdmins(payload: AdminBroadcastPayload): void {
  if (!registered) return;
  try {
    registered(payload);
  } catch {
    // fire-and-forget
  }
}
