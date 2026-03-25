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

      if (connectionManager.hasActiveConnection(agent.id)) {
        socket.close(connectionManager.WS_CLOSE_ALREADY_CONNECTED, "Agent already connected");
        return;
      }

      const inboxId = agent.inboxId;

      await presenceService.setOnline(app.db, agent.id, instanceId);
      connectionManager.setConnection(agent.id, socket);
      notifier.subscribe(inboxId, socket);

      socket.on("close", async () => {
        notifier.unsubscribe(inboxId, socket);
        connectionManager.removeConnection(agent.id, socket);
        try {
          await presenceService.setOffline(app.db, agent.id);
        } catch {
          // best-effort
        }
      });
    });
  };
}
