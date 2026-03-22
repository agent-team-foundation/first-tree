import type { FastifyInstance } from "fastify";
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

      const inboxId = agent.inboxId;

      // Track presence
      await presenceService.setOnline(app.db, agent.id, instanceId);

      // Subscribe to notifications
      notifier.subscribe(inboxId, socket);

      socket.on("close", async () => {
        notifier.unsubscribe(inboxId, socket);
        try {
          await presenceService.setOffline(app.db, agent.id);
        } catch {
          // best-effort
        }
      });

      // Keep-alive: respond to pings (handled automatically by ws)
      // Client can send JSON messages, but we don't process them in v2
    });
  };
}
