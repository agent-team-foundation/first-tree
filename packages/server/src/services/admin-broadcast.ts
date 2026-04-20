/**
 * Admin WebSocket broadcast seam.
 *
 * A single registered broadcaster, owned by the admin WS route, lets any
 * service push a payload to every admin socket without importing the WS route
 * module (which would drag Fastify + `ws` into service-layer code). The seam
 * also keeps the registration pattern composable — notification, session-state
 * forwarding, and future pulse-tick ticks all share one channel without the
 * "second register overwrites the first" trap of the former module-level
 * singleton.
 */

export type AdminBroadcastPayload = Record<string, unknown>;
export type AdminBroadcaster = (payload: AdminBroadcastPayload) => void;

let registered: AdminBroadcaster | null = null;

/** Install the broadcaster. Called once at app startup by the admin WS route. */
export function registerAdminBroadcaster(fn: AdminBroadcaster): void {
  registered = fn;
}

/** Reset to the unregistered state. Intended for tests. */
export function resetAdminBroadcaster(): void {
  registered = null;
}

/**
 * Forward a payload to every admin socket whose org matches
 * `payload.organizationId`. Callers MUST include `organizationId` at the top
 * level of the payload; org-less payloads are rejected (no-op) so the route's
 * org filter never falls back to a cross-org broadcast.
 */
export function broadcastToAdmins(payload: AdminBroadcastPayload): void {
  if (!registered) return;
  try {
    registered(payload);
  } catch {
    // fire-and-forget
  }
}
