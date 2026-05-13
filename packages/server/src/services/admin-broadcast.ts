/**
 * Service-layer seam for pushing payloads to admin WebSocket sockets.
 *
 * Two registration points:
 *  - `registerAdminBroadcaster` — per-instance fanout to admin sockets attached
 *    to THIS server process. Wired by orgWsRoutes once the admin route is up.
 *  - `registerCrossInstanceBroadcaster` — cross-instance pg_notify fanout.
 *    Wired by app.ts during boot; the LISTEN handler on every instance feeds
 *    the inbound envelope back into `broadcastToAdmins` so all admin sockets
 *    across all instances see the same event.
 *
 * Producers (notification.ts) should call `broadcastAdminsCrossInstance`. Tests
 * and per-instance subsystems (pulse aggregator) call `broadcastToAdmins`
 * directly because their fanout is scoped to the local process anyway.
 */

export type AdminBroadcastPayload = Record<string, unknown>;
export type AdminBroadcaster = (payload: AdminBroadcastPayload) => void;

let localBroadcaster: AdminBroadcaster | null = null;
let crossInstanceBroadcaster: AdminBroadcaster | null = null;

export function registerAdminBroadcaster(fn: AdminBroadcaster): void {
  localBroadcaster = fn;
}

export function registerCrossInstanceBroadcaster(fn: AdminBroadcaster): void {
  crossInstanceBroadcaster = fn;
}

export function resetAdminBroadcaster(): void {
  localBroadcaster = null;
  crossInstanceBroadcaster = null;
}

export function broadcastToAdmins(payload: AdminBroadcastPayload): void {
  if (!localBroadcaster) return;
  try {
    localBroadcaster(payload);
  } catch {
    // fire-and-forget
  }
}

/**
 * Fan out to every admin socket across every server instance via PG NOTIFY.
 * Falls back to single-instance fanout when no cross-instance broadcaster is
 * registered (e.g. unit tests that don't boot a notifier).
 */
export function broadcastAdminsCrossInstance(payload: AdminBroadcastPayload): void {
  if (crossInstanceBroadcaster) {
    try {
      crossInstanceBroadcaster(payload);
    } catch {
      // fire-and-forget
    }
    return;
  }
  broadcastToAdmins(payload);
}
