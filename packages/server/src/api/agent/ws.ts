import type { FastifyInstance } from "fastify";
import * as connectionManager from "../../services/connection-manager.js";
import type { Notifier } from "../../services/notifier.js";
import * as presenceService from "../../services/presence.js";

export function agentWsRoutes(notifier: Notifier, instanceId: string) {
  return async (app: FastifyInstance): Promise<void> => {
    app.get("/inbox", { websocket: true }, async (socket, request) => {
      const agent = request.agent;
      if (!agent) {
        socket.close(4001, "Unauthorized");
        return;
      }

      if (connectionManager.hasActiveConnection(agent.uuid)) {
        socket.close(connectionManager.WS_CLOSE_ALREADY_CONNECTED, "Agent already connected");
        return;
      }

      const inboxId = agent.inboxId;

      await presenceService.setOnline(app.db, agent.uuid, instanceId);
      connectionManager.setConnection(agent.uuid, socket);
      notifier.subscribe(inboxId, socket);

      socket.on("close", async () => {
        notifier.unsubscribe(inboxId, socket);
        const wasActive = connectionManager.removeConnection(agent.uuid, socket);
        // Only set offline if this socket was still the active connection.
        // A newer socket may have replaced it — avoid overwriting its online status.
        if (wasActive) {
          try {
            await presenceService.setOffline(app.db, agent.uuid);
          } catch {
            // best-effort
          }
        }
      });
    });
  };
}
