import {
  agentPinnedMessageSchema,
  PROVIDER_MODELS_LIST_TYPE,
  RUNTIME_INSTALL_START_TYPE,
  runtimeInstallTerminalResultFrameSchema,
} from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import type { Notifier } from "../../../services/notifier.js";
import * as clientService from "../../../services/runtime/client.js";
import * as connectionManager from "../../../services/runtime/connection-manager.js";
import { readModelCatalogRpcResult } from "../../../services/runtime/rpc/provider-models.js";
import {
  metadataSupportsRuntimeInstallV1,
  recordRuntimeInstallProgress,
} from "../../../services/runtime/rpc/runtime-install.js";
import { agentRoutedTo, readSessionCommandRpcResult } from "../../../services/runtime/rpc/session-command.js";

export function registerClientWsServerEvents(app: FastifyInstance, notifier: Notifier, instanceId: string): void {
  notifier.onAgentRouteChange((payload) => {
    if (payload.oldClientId) {
      connectionManager.forceDisconnect(payload.agentId, payload.reason, payload.oldClientId);
    }
    const frame = agentPinnedMessageSchema.safeParse({
      type: "agent:pinned",
      agentId: payload.agentId,
      name: payload.name,
      displayName: payload.displayName,
      agentType: payload.agentType,
      runtimeProvider: payload.runtimeProvider,
    });
    if (!frame.success) {
      app.log.warn(
        { err: frame.error.flatten(), agentId: payload.agentId, clientId: payload.targetClientId },
        "agent route change frame failed schema validation — not sending",
      );
      return;
    }
    connectionManager.sendToClient(payload.targetClientId, frame.data);
  });

  notifier.onDaemonClientCommand((payload) => {
    if (payload.targetInstanceId !== instanceId) return;
    if (payload.type === PROVIDER_MODELS_LIST_TYPE) {
      connectionManager.sendToClient(payload.clientId, {
        type: PROVIDER_MODELS_LIST_TYPE,
        provider: payload.provider,
        ref: payload.ref,
      });
      return;
    }
    if (payload.type === RUNTIME_INSTALL_START_TYPE) {
      void (async () => {
        const client = await clientService.getClient(app.db, payload.clientId);
        if (
          !client ||
          client.status !== "connected" ||
          client.instanceId !== payload.targetInstanceId ||
          !metadataSupportsRuntimeInstallV1(client.metadata)
        ) {
          return;
        }
        connectionManager.sendToClient(payload.clientId, {
          type: RUNTIME_INSTALL_START_TYPE,
          provider: payload.provider,
          ref: payload.ref,
        });
      })().catch((err) => {
        app.log.warn({ err, clientId: payload.clientId, ref: payload.ref }, "runtime install fan-out failed");
      });
      return;
    }
    if (payload.type === "session:command:finalized" || payload.type === "session:command:aborted") {
      // A disposition must return to the original applying Client. Rechecking
      // the Agent's current route or capability here could strand an already
      // applied Reset generation behind its own fence.
      const frame =
        payload.type === "session:command:finalized"
          ? { type: payload.type, state: "evicted" as const }
          : { type: payload.type, reason: payload.reason };
      connectionManager.sendToClient(payload.clientId, {
        ...frame,
        ref: payload.ref,
        ackRef: payload.ackRef,
        agentId: payload.agentId,
        chatId: payload.chatId,
        command: "session:terminate",
      });
      return;
    }

    // Destructive apply delivery must still target the current durable route,
    // this instance, and a live socket that advertises the complete protocol.
    void (async () => {
      const routed = await agentRoutedTo(app.db, payload.agentId, payload.clientId, payload.targetInstanceId, {
        requireSessionResetV1: true,
      });
      if (!routed) return;
      if (connectionManager.getAgentClientId(payload.agentId) !== payload.clientId) return;
      if (!connectionManager.agentSupportsSessionResetV1(payload.agentId)) return;
      connectionManager.sendToClient(payload.clientId, {
        type: "session:terminate",
        agentId: payload.agentId,
        chatId: payload.chatId,
        ref: payload.ref,
      });
    })().catch((err) => {
      app.log.warn({ err, clientId: payload.clientId, ref: payload.ref }, "session terminate fan-out failed");
    });
  });

  notifier.onDaemonClientCommandResult((payload) => {
    if (payload.result) {
      recordRuntimeInstallProgress(payload.clientId, payload.result);
      const terminal = runtimeInstallTerminalResultFrameSchema.safeParse(payload.result);
      if (terminal.success) {
        connectionManager.resolveClientReply(payload.clientId, payload.ref, terminal.data);
      }
      return;
    }
    void (async () => {
      const ack = await readSessionCommandRpcResult(app.db, payload.clientId, payload.ref);
      if (ack) {
        connectionManager.resolveClientReply(payload.clientId, payload.ref, ack);
        return;
      }
      const catalog = await readModelCatalogRpcResult(app.db, payload.clientId, payload.ref);
      if (!catalog) return;
      connectionManager.resolveClientReply(payload.clientId, payload.ref, catalog);
    })().catch((err) => {
      app.log.debug({ err, clientId: payload.clientId, ref: payload.ref }, "daemon command result wake failed");
    });
  });
}
