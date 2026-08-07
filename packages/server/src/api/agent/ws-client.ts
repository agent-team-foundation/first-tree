import type { FastifyInstance } from "fastify";
import type { Notifier } from "../../services/notifier.js";
import { attachClientWsConnection } from "./ws-client/connection.js";
import { registerClientWsServerEvents } from "./ws-client/server-events.js";

export function clientWsRoutes(notifier: Notifier, instanceId: string) {
  return async (app: FastifyInstance): Promise<void> => {
    registerClientWsServerEvents(app, notifier, instanceId);
    app.get("/client", { websocket: true }, async (socket, request) => {
      attachClientWsConnection(app, socket, request, notifier, instanceId);
    });
  };
}
