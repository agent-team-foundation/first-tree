import {
  agentPinnedMessageSchema,
  clientRegisterSchema,
  PROVIDER_MODELS_RESULT_TYPE,
  providerModelsResultFrameSchema,
} from "@first-tree/shared";
import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { members } from "../../../db/schema/members.js";
import { ClientOrgMismatchError, ClientRetiredError, ClientUserMismatchError } from "../../../errors.js";
import { setWsConnectionAttrs } from "../../../observability/index.js";
import * as clientService from "../../../services/client.js";
import * as connectionManager from "../../../services/connection-manager.js";
import type { Notifier } from "../../../services/notifier.js";
import { storeModelCatalogRpcResult } from "../../../services/provider-models-rpc.js";
import * as runtimeLivenessService from "../../../services/runtime-liveness.js";
import { setAuthWsAttrs } from "./auth.js";
import type { ClientWsConnectionContext } from "./connection-context.js";
import type { InboxDeliveryCoordinator } from "./inbox-delivery.js";

export function createClientFrameHandler(
  app: FastifyInstance,
  socket: WebSocket,
  notifier: Notifier,
  instanceId: string,
  context: ClientWsConnectionContext,
  inbox: InboxDeliveryCoordinator,
) {
  function sendPinnedAgentFrame(agent: {
    uuid: string;
    name: string | null;
    displayName: string;
    type: string;
    runtimeProvider: string;
  }): void {
    const parsed = agentPinnedMessageSchema.safeParse({
      type: "agent:pinned",
      agentId: agent.uuid,
      name: agent.name,
      displayName: agent.displayName,
      agentType: agent.type,
      runtimeProvider: agent.runtimeProvider,
    });
    if (!parsed.success) {
      app.log.warn(
        { err: parsed.error.flatten(), agentId: agent.uuid, clientId: context.getClientId() },
        "agent:pinned backfill frame failed schema validation — skipping",
      );
      return;
    }
    socket.send(JSON.stringify(parsed.data));
  }

  async function reconcilePinnedAgentsForClient(): Promise<void> {
    const clientId = context.getClientId();
    if (!clientId || socket.readyState !== socket.OPEN) return;
    const pinned = await clientService.listActiveAgentsPinnedToClient(app.db, clientId);
    for (const agent of pinned) {
      const local = context.getBoundAgent(agent.uuid);
      if (local?.runtimeProvider === agent.runtimeProvider && context.isAgentStillRoutedHere(agent.uuid)) {
        continue;
      }
      sendPinnedAgentFrame(agent);
    }
  }

  return async function handleClientFrame(type: string, msg: unknown): Promise<boolean | undefined> {
    const session = context.getSession();
    if (!session) return false;
    const clientId = context.getClientId();
    const jwtDefaultOrgId = context.getJwtDefaultOrgId();
    const boundAgents = {
      keys: context.boundAgentIds,
      values: context.boundAgentValues,
    };
    if (type === "client:register") {
      const data = clientRegisterSchema.parse(msg);

      // Resolve a placeholder `organizationId` for the legacy NOT NULL
      // column on `clients`. The column is no longer read by any path
      // (decouple-client-from-identity §4.1.1) but still has the FK
      // constraint, so we need *some* valid org id at INSERT time. Use
      // the user's most-recently-active membership; fall back to
      // jwtDefaultOrgId for legacy tokens that still carry it.
      let placeholderOrgId = jwtDefaultOrgId;
      if (!placeholderOrgId) {
        const [m] = await app.db
          .select({ organizationId: members.organizationId })
          .from(members)
          .where(and(eq(members.userId, session.userId), eq(members.status, "active")))
          .orderBy(desc(members.createdAt), desc(members.id))
          .limit(1);
        placeholderOrgId = m?.organizationId ?? null;
      }
      if (!placeholderOrgId) {
        setAuthWsAttrs(socket, {
          phase: "client_register",
          outcome: "rejected",
          code: "no_membership",
          retryable: false,
          closeCode: 4403,
        });
        socket.send(
          JSON.stringify({
            type: "client:register:rejected",
            message: "User has no active organization membership",
          }),
        );
        socket.close(4403, "no membership");
        return;
      }
      try {
        await clientService.registerClient(app.db, {
          clientId: data.clientId,
          userId: session.userId,
          organizationId: placeholderOrgId,
          instanceId,
          hostname: data.hostname,
          os: data.os,
          sdkVersion: data.sdkVersion,
          lastUpdateAttempt: data.lastUpdateAttempt,
          wireCapabilities: data.wireCapabilities,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "client register failed";
        const code =
          err instanceof ClientUserMismatchError
            ? err.code
            : err instanceof ClientOrgMismatchError || err instanceof ClientRetiredError
              ? err.code
              : undefined;
        setAuthWsAttrs(socket, {
          phase: "client_register",
          outcome: "rejected",
          code: code ?? "client_register_failed",
          retryable: false,
          closeCode: 4403,
          errorClass: err instanceof Error ? err.name : "UnknownError",
        });
        socket.send(
          JSON.stringify({
            type: "client:register:rejected",
            message,
            ...(code ? { code } : {}),
          }),
        );
        socket.close(4403, "client register rejected");
        return;
      }

      context.setClientId(data.clientId);
      setWsConnectionAttrs(socket, { "client.id": data.clientId });
      connectionManager.setClientConnection(data.clientId, socket, data.wireCapabilities);
      socket.send(JSON.stringify({ type: "client:registered", clientId: data.clientId }));

      // Backfill `agent:pinned` for any agent already bound to this
      // client at registration time. Without this, an admin who pins an
      // agent while the client is offline would still need a manual
      // `agent add` after restart — the realtime push in
      // admin/agents.ts only fires for live sockets. The client dedupes
      // on agentId, so re-firing on every reconnect is safe.
      try {
        await reconcilePinnedAgentsForClient();
      } catch (err) {
        app.log.error(
          { err, clientId: data.clientId },
          "agent:pinned backfill on client:register failed — client may need manual `agent add`",
        );
      }
    } else if (type === "heartbeat") {
      if (clientId && connectionManager.isActiveClientConnection(clientId, socket)) {
        const routedAgentIds = [];
        for (const id of boundAgents.keys()) {
          if (await context.ensureAgentStillRoutedHere(id)) routedAgentIds.push(id);
        }
        const pausedReason =
          msg && typeof msg === "object" && "pausedReason" in msg
            ? ((msg as { pausedReason?: "auth_rejected" | "auth_refresh_failed" | null }).pausedReason ?? null)
            : null;
        const liveness = await runtimeLivenessService.recordClientHeartbeat(app.db, {
          clientId,
          instanceId,
          routedAgentIds,
          pausedReason,
        });
        const repairableAgentIds = new Set(liveness.restoredAgentIds);
        for (const info of boundAgents.values()) {
          if (repairableAgentIds.has(info.agentId) && (await context.ensureAgentStillRoutedHere(info.agentId))) {
            inbox.maybeRepair(info.agentId, info.inboxId);
          }
        }
        await reconcilePinnedAgentsForClient();
      }
      socket.send(JSON.stringify({ type: "heartbeat:ack" }));
    } else if (type === PROVIDER_MODELS_RESULT_TYPE) {
      if (!clientId) {
        socket.send(JSON.stringify({ type: "error", message: "Must register client first" }));
        return;
      }
      const result = providerModelsResultFrameSchema.safeParse(msg);
      if (!result.success) {
        socket.send(JSON.stringify({ type: "error", message: "Malformed provider-models:result frame" }));
        return;
      }
      // Reject a locally replaced socket before touching durable state.
      if (!connectionManager.isActiveClientConnection(clientId, socket)) {
        app.log.debug({ clientId, ref: result.data.ref }, "ignoring provider-models:result from replaced local socket");
        return;
      }
      // Ownership + persist are one UPDATE (`id` AND `instance_id`); a
      // takeover between a prior SELECT and write cannot land a catalog.
      const stored = await storeModelCatalogRpcResult(
        app.db,
        clientId,
        result.data.ref,
        result.data.catalog,
        instanceId,
      );
      if (!stored) {
        app.log.debug(
          { clientId, ref: result.data.ref, instanceId },
          "ignoring provider-models:result; client ownership moved before durable write",
        );
        return;
      }
      const resolved = connectionManager.resolveClientReply(clientId, result.data.ref, result.data.catalog);
      await notifier.notifyDaemonClientCommandResult({ clientId, ref: result.data.ref });
      if (!resolved) {
        app.log.debug(
          { clientId, ref: result.data.ref },
          "provider-models:result matched no pending HTTP waiter on this replica",
        );
      }
    } else return false;
    return true;
  };
}
