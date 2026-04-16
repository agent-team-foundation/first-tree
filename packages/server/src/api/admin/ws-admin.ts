import type { FastifyInstance } from "fastify";
import { jwtVerify } from "jose";
import type { WebSocket } from "ws";
import { setAdminWsBroadcast } from "../../services/notification.js";
import type { Notifier } from "../../services/notifier.js";

/**
 * M1 Admin WebSocket: real-time push channel for Dashboard.
 *
 * Protocol:
 *   1. Client connects with JWT token via query param `?token=<jwt>`
 *   2. Server validates JWT and registers the connection
 *   3. Server pushes notifications and session state changes in real-time
 *   4. No client→server messages expected (read-only channel)
 */
export function adminWsRoutes(notifier: Notifier, jwtSecret: string) {
  const adminSockets = new Set<WebSocket>();
  const secret = new TextEncoder().encode(jwtSecret);

  // Register the broadcast function for the notification service
  setAdminWsBroadcast((payload) => {
    const data = JSON.stringify(payload);
    for (const ws of adminSockets) {
      if (ws.readyState === 1) {
        ws.send(data);
      }
    }
  });

  // Subscribe to session state changes and forward to admin sockets
  notifier.onSessionStateChange((payload) => {
    const data = JSON.stringify({ type: "session:state", ...payload });
    for (const ws of adminSockets) {
      if (ws.readyState === 1) {
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

      try {
        const { payload } = await jwtVerify(token, secret);
        if (payload.type !== "access" || !payload.sub) {
          socket.send(JSON.stringify({ type: "error", message: "Invalid token type" }));
          socket.close(4001, "Invalid token");
          return;
        }
      } catch {
        socket.send(JSON.stringify({ type: "error", message: "Invalid or expired token" }));
        socket.close(4001, "Auth failed");
        return;
      }

      adminSockets.add(socket);
      socket.send(JSON.stringify({ type: "admin:connected" }));

      socket.on("close", () => {
        adminSockets.delete(socket);
      });
    });
  };
}
