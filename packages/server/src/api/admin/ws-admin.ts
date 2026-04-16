import type { FastifyInstance } from "fastify";
import { jwtVerify } from "jose";
import type { WebSocket } from "ws";
import { setAdminWsBroadcast } from "../../services/notification.js";
import type { Notifier } from "../../services/notifier.js";

/**
 * Admin WebSocket: real-time push channel for Dashboard, scoped by organization.
 *
 * Protocol:
 *   1. Client connects with JWT token via query param `?token=<jwt>`
 *   2. Server validates JWT, extracts organizationId, and registers the connection
 *   3. Server pushes notifications and session state changes filtered by org
 *   4. No client→server messages expected (read-only channel)
 */
export function adminWsRoutes(notifier: Notifier, jwtSecret: string) {
  const adminSockets = new Map<WebSocket, { organizationId: string }>();
  const secret = new TextEncoder().encode(jwtSecret);

  // Register the broadcast function for the notification service
  setAdminWsBroadcast((payload) => {
    const orgId = (payload as Record<string, unknown>).organizationId as string | undefined;
    const data = JSON.stringify(payload);
    for (const [ws, meta] of adminSockets) {
      if (ws.readyState === 1 && (!orgId || meta.organizationId === orgId)) {
        ws.send(data);
      }
    }
  });

  // Subscribe to session state changes and forward to matching admin sockets
  notifier.onSessionStateChange((payload) => {
    const data = JSON.stringify({ type: "session:state", ...payload });
    const orgId = (payload as Record<string, unknown>).organizationId as string | undefined;
    for (const [ws, meta] of adminSockets) {
      if (ws.readyState === 1 && (!orgId || meta.organizationId === orgId)) {
        ws.send(data);
      }
    }
  });

  return async (app: FastifyInstance): Promise<void> => {
    app.get("/admin", { websocket: true }, async (socket, request) => {
      // Authenticate via query param
      const token = (request.query as Record<string, string>).token;
      if (!token) {
        socket.send(JSON.stringify({ type: "error", message: "Missing token query parameter" }));
        socket.close(4001, "Missing token");
        return;
      }

      let organizationId: string;
      try {
        const { payload } = await jwtVerify(token, secret);
        if (payload.type !== "access" || !payload.sub || !payload.organizationId) {
          socket.send(JSON.stringify({ type: "error", message: "Invalid token type" }));
          socket.close(4001, "Invalid token");
          return;
        }
        organizationId = payload.organizationId as string;
      } catch {
        socket.send(JSON.stringify({ type: "error", message: "Invalid or expired token" }));
        socket.close(4001, "Auth failed");
        return;
      }

      adminSockets.set(socket, { organizationId });
      socket.send(JSON.stringify({ type: "admin:connected" }));

      socket.on("close", () => {
        adminSockets.delete(socket);
      });
    });
  };
}
