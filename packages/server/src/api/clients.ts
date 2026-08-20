import { randomUUID } from "node:crypto";
import {
  PROVIDER_MODELS_LIST_TYPE,
  providerModelCatalogSchema,
  RUNTIME_AUTH_START_TYPE,
  RUNTIME_INSTALL_START_TYPE,
  runtimeAuthStartRequestSchema,
  runtimeInstallStartRequestSchema,
  runtimeInstallStartResponseSchema,
  runtimeInstallTerminalResultFrameSchema,
  runtimeProviderSchema,
  updateClientCapabilitiesSchema,
} from "@first-tree/shared";
import { getChannelConfig } from "@first-tree/shared/channel";
import type { FastifyInstance } from "fastify";
import { BadGatewayError, GatewayTimeoutError, ServiceUnavailableError } from "../errors.js";
import { stampClientResource } from "../observability/request-context.js";
import { requireUser } from "../scope/require-user.js";
import { expiryToSeconds } from "../services/auth/tokens.js";
import * as clientService from "../services/runtime/client.js";
import {
  cancelClientReply,
  forceDisconnectClient,
  rejectPendingRepliesForClient,
  sendToClient,
  waitForClientReply,
} from "../services/runtime/connection-manager.js";
import { isClientConnectedSomewhere, readModelCatalogRpcResult } from "../services/runtime/rpc/provider-models.js";
import {
  beginRuntimeInstallProgress,
  metadataSupportsRuntimeInstallV1,
  RUNTIME_INSTALL_REPLY_TIMEOUT_MS,
  runtimeInstallClientLiveness,
  takeRuntimeInstallProgress,
} from "../services/runtime/rpc/runtime-install.js";
import { serializeDate } from "../utils.js";
import { clientCommandVersionHint } from "./client-command-version.js";

/**
 * Class C — `/api/v1/clients/:id` and member-self utilities. A client is
 * owned by exactly one user (cross-org under one user is allowed); the
 * org doesn't appear in this URL because it doesn't gate access.
 */
export async function clientRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { clientId: string } }>("/:clientId", async (request) => {
    const { userId } = requireUser(request);
    const { clientId } = request.params;
    stampClientResource(request, clientId);
    await clientService.assertClientOwner(app.db, clientId, { userId });
    const client = await clientService.getClient(app.db, clientId);
    if (!client) throw new Error("unreachable: client missing after owner check");
    // Normalize through the capability schema (same as /me/clients) so a legacy
    // snapshot is coerced to the canonical install-only shape rather than served
    // raw — the chat login button polls this endpoint and must not receive a
    // legacy `unauthenticated` state the web no longer handles.
    const capabilities = clientService.extractCapabilities(client.metadata);
    const refreshExpirySeconds = expiryToSeconds(app.config.auth.refreshTokenExpiry);
    const binName = getChannelConfig(app.config.channel).binName;
    return {
      id: client.id,
      userId: client.userId,
      status: clientService.clientStatusForApi(client),
      authState: clientService.deriveAuthState(client, refreshExpirySeconds),
      binName,
      sdkVersion: client.sdkVersion,
      hostname: client.hostname,
      os: client.os,
      connectedAt: serializeDate(client.connectedAt),
      lastSeenAt: client.lastSeenAt.toISOString(),
      capabilities,
      lastUpdateAttempt: clientService.extractLastUpdateAttempt(client.metadata),
      ...clientCommandVersionHint(app, client.sdkVersion),
    };
  });

  app.patch<{ Params: { clientId: string } }>("/:clientId/capabilities", async (request, reply) => {
    const { userId } = requireUser(request);
    const { clientId } = request.params;
    stampClientResource(request, clientId);
    await clientService.assertClientOwner(app.db, clientId, { userId });
    await clientService.assertClientNotRetired(app.db, clientId);
    const body = updateClientCapabilitiesSchema.parse(request.body);
    await clientService.updateClientCapabilities(app.db, clientId, body.capabilities);
    return reply.status(204).send();
  });

  // Start an in-product runtime-auth login on the connected daemon: the member
  // clicked "Connect <provider>" in the console. We forward a reverse command
  // over the client's live WS (same precedent as session suspend/resume); the
  // daemon runs the provider's official login and reflects progress by
  // re-PATCHing capabilities, which the web polls. Fire-and-forget: 503 only if
  // the daemon is not connected to this server process.
  app.post<{ Params: { clientId: string } }>("/:clientId/runtime-auth/start", async (request) => {
    const { userId } = requireUser(request);
    const { clientId } = request.params;
    stampClientResource(request, clientId);
    await clientService.assertClientOwner(app.db, clientId, { userId });
    await clientService.assertClientNotRetired(app.db, clientId);
    const body = runtimeAuthStartRequestSchema.parse(request.body);
    const ref = randomUUID();
    const delivered = sendToClient(clientId, {
      type: RUNTIME_AUTH_START_TYPE,
      provider: body.provider,
      ...(body.method ? { method: body.method } : {}),
      ref,
    });
    if (!delivered) {
      throw new ServiceUnavailableError(
        "Runtime-auth could not start because this computer is not connected. Make sure the daemon is running, then retry.",
      );
    }
    return { ref, started: true as const };
  });

  // Install one allowlisted runtime engine on the selected Computer. The HTTP
  // request stays open for the terminal result so no durable job/progress state
  // is introduced; daemon progress/result frames are ref-correlated across
  // replicas through the existing reverse-command notifier channel.
  app.post<{ Params: { clientId: string } }>("/:clientId/runtime-install/start", async (request) => {
    const { userId } = requireUser(request);
    const { clientId } = request.params;
    stampClientResource(request, clientId);
    await clientService.assertClientOwner(app.db, clientId, { userId });
    await clientService.assertClientNotRetired(app.db, clientId);
    const body = runtimeInstallStartRequestSchema.parse(request.body);
    const client = await clientService.getClient(app.db, clientId);
    if (!client) throw new Error("unreachable: client missing after owner check");

    const liveness = runtimeInstallClientLiveness(client, new Date(), app.config.runtime.presenceCleanupSeconds);
    if (liveness === "disconnected") {
      throw new ServiceUnavailableError(
        "Runtime installation could not start because this computer is not connected. Start its daemon, then retry.",
      );
    }
    if (liveness === "stale") {
      throw new ServiceUnavailableError(
        "Runtime installation could not start because this computer's connection is stale. Restart its daemon, then retry.",
      );
    }
    if (!metadataSupportsRuntimeInstallV1(client.metadata)) {
      throw new ServiceUnavailableError(
        "Runtime installation is unavailable because this computer's daemon does not support controlled installs. Update and restart it, then retry.",
      );
    }
    const targetInstanceId = client.instanceId;
    if (!targetInstanceId) throw new Error("unreachable: live client missing instance id");

    const ref = randomUUID();
    beginRuntimeInstallProgress(clientId, body.provider, ref);
    const replyPromise = waitForClientReply(clientId, ref, RUNTIME_INSTALL_REPLY_TIMEOUT_MS);
    const command = { type: RUNTIME_INSTALL_START_TYPE, provider: body.provider, ref };
    if (targetInstanceId === app.config.instanceId) {
      const delivered = sendToClient(clientId, command);
      if (!delivered) {
        cancelClientReply(clientId, ref, new Error("Computer not connected"));
        await replyPromise.catch(() => undefined);
        takeRuntimeInstallProgress(clientId, ref);
        throw new ServiceUnavailableError(
          "Runtime installation could not start because this computer is not connected. Start its daemon, then retry.",
        );
      }
    } else {
      await app.notifier.notifyDaemonClientCommand({
        ...command,
        clientId,
        targetInstanceId,
      });
    }

    try {
      const terminal = runtimeInstallTerminalResultFrameSchema.parse(await replyPromise);
      const progress = takeRuntimeInstallProgress(clientId, ref);
      const { type: _type, ...result } = terminal;
      return runtimeInstallStartResponseSchema.parse({ ...result, progress });
    } catch (err) {
      takeRuntimeInstallProgress(clientId, ref);
      const timedOut = err instanceof Error && err.message.toLowerCase().includes("timed out");
      if (timedOut) {
        throw new GatewayTimeoutError(
          "Timed out waiting for this computer to finish installing the runtime. Check the daemon log before retrying.",
        );
      }
      throw new BadGatewayError(
        err instanceof Error ? err.message : "The computer did not return a valid runtime installation result.",
      );
    }
  });

  // Host-local model catalog: ask the connected daemon to discover models from
  // the real provider on that computer, wait for the correlated reply, and
  // return the catalog to the web. Delivery is scoped to the DB-authoritative
  // `clients.instance_id` (local send or PG NOTIFY fan-out). Results are stored
  // in clients.metadata; on waiter timeout we still read that durable copy so a
  // lost NOTIFY does not false-fail. Computer offline → 502; reply timeout → 504
  // (web picker maps both to silent degrade; avoid 503 which triggers retry).
  app.get<{ Params: { clientId: string; provider: string } }>(
    "/:clientId/providers/:provider/models",
    async (request) => {
      const { userId } = requireUser(request);
      const { clientId, provider: rawProvider } = request.params;
      stampClientResource(request, clientId);
      await clientService.assertClientOwner(app.db, clientId, { userId });
      await clientService.assertClientNotRetired(app.db, clientId);
      const provider = runtimeProviderSchema.parse(rawProvider);
      const client = await clientService.getClient(app.db, clientId);
      if (!client || !isClientConnectedSomewhere(client) || !client.instanceId) {
        throw new BadGatewayError(
          "Could not list models because this computer is not connected. Make sure the daemon is running, then retry.",
        );
      }
      const targetInstanceId = client.instanceId;
      const ref = randomUUID();
      const replyPromise = waitForClientReply(clientId, ref);
      const daemonFrame = {
        type: PROVIDER_MODELS_LIST_TYPE,
        provider,
        ref,
      };
      if (targetInstanceId === app.config.instanceId) {
        const delivered = sendToClient(clientId, daemonFrame);
        if (!delivered) {
          rejectPendingRepliesForClient(clientId, new Error("Computer not connected"));
          await replyPromise.catch(() => undefined);
          throw new BadGatewayError(
            "Could not list models because this computer is not connected. Make sure the daemon is running, then retry.",
          );
        }
      } else {
        await app.notifier.notifyDaemonClientCommand({
          type: PROVIDER_MODELS_LIST_TYPE,
          clientId,
          provider,
          ref,
          targetInstanceId,
        });
      }
      try {
        const raw = await replyPromise;
        return providerModelCatalogSchema.parse(raw);
      } catch (err) {
        // Race-safe fallback: catalog may already be durable while the wake was lost.
        const stored = await readModelCatalogRpcResult(app.db, clientId, ref);
        if (stored) return stored;
        const timedOut = err instanceof Error && err.message.toLowerCase().includes("timed out");
        if (timedOut) {
          throw new GatewayTimeoutError(
            err instanceof Error ? err.message : "Timed out waiting for this computer to list models.",
          );
        }
        throw new BadGatewayError(
          err instanceof Error
            ? err.message
            : "Could not list models from this computer. Retry after the daemon is connected.",
        );
      }
    },
  );

  app.post<{ Params: { clientId: string } }>("/:clientId/disconnect", async (request) => {
    const { userId } = requireUser(request);
    const { clientId } = request.params;
    stampClientResource(request, clientId);
    await clientService.assertClientOwner(app.db, clientId, { userId });
    await clientService.assertClientNotRetired(app.db, clientId);
    const agentIds = forceDisconnectClient(clientId);
    await clientService.disconnectClient(app.db, clientId);
    return { disconnected: true, agentIds };
  });

  app.delete<{ Params: { clientId: string } }>("/:clientId", async (request, reply) => {
    const { userId } = requireUser(request);
    const { clientId } = request.params;
    stampClientResource(request, clientId);
    await clientService.assertClientOwner(app.db, clientId, { userId });
    await clientService.retireClient(app.db, clientId);
    forceDisconnectClient(clientId);
    return reply.status(204).send();
  });

  // POST /:clientId/claim (cross-user ownership transfer) was removed: a
  // clientId is org-visible, so with only-JWT auth the route let any
  // authenticated user knock another user's machine offline. Machine handover
  // is local-only: the operator must `login <code>` as the target user so
  // the old local client is parked and a separate local client identity is
  // activated (no server-side transfer protocol to secure).
}
