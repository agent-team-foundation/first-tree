import { randomUUID } from "node:crypto";
import {
  PROVIDER_MODELS_LIST_TYPE,
  providerModelCatalogSchema,
  RUNTIME_AUTH_START_TYPE,
  runtimeAuthStartRequestSchema,
  runtimeProviderSchema,
  updateClientCapabilitiesSchema,
} from "@first-tree/shared";
import { getChannelConfig } from "@first-tree/shared/channel";
import type { FastifyInstance } from "fastify";
import { ServiceUnavailableError } from "../errors.js";
import { stampClientResource } from "../observability/request-context.js";
import { requireUser } from "../scope/require-user.js";
import { expiryToSeconds } from "../services/auth.js";
import * as clientService from "../services/client.js";
import {
  forceDisconnectClient,
  rejectPendingRepliesForClient,
  sendToClient,
  waitForClientReply,
} from "../services/connection-manager.js";
import { isClientConnectedSomewhere } from "../services/provider-models-rpc.js";
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

  // Host-local model catalog: ask the connected daemon to discover models from
  // the real provider on that computer, wait for the correlated reply, and
  // return the catalog to the web. When the daemon socket lives on another
  // replica, fan the reverse command via PG NOTIFY; the result is stored in
  // clients.metadata and woken with a tiny result NOTIFY. 503 when offline
  // or timed out.
  app.get<{ Params: { clientId: string; provider: string } }>(
    "/:clientId/providers/:provider/models",
    async (request) => {
      const { userId } = requireUser(request);
      const { clientId, provider: rawProvider } = request.params;
      stampClientResource(request, clientId);
      await clientService.assertClientOwner(app.db, clientId, { userId });
      await clientService.assertClientNotRetired(app.db, clientId);
      const provider = runtimeProviderSchema.parse(rawProvider);
      const ref = randomUUID();
      const replyPromise = waitForClientReply(clientId, ref);
      const command = {
        type: PROVIDER_MODELS_LIST_TYPE,
        provider,
        ref,
      };
      const deliveredLocally = sendToClient(clientId, command);
      if (!deliveredLocally) {
        const client = await clientService.getClient(app.db, clientId);
        if (!client || !isClientConnectedSomewhere(client)) {
          rejectPendingRepliesForClient(clientId, new Error("Computer not connected"));
          await replyPromise.catch(() => undefined);
          throw new ServiceUnavailableError(
            "Could not list models because this computer is not connected. Make sure the daemon is running, then retry.",
          );
        }
        await app.notifier.notifyDaemonClientCommand({
          type: PROVIDER_MODELS_LIST_TYPE,
          clientId,
          provider,
          ref,
        });
      }
      try {
        const raw = await replyPromise;
        return providerModelCatalogSchema.parse(raw);
      } catch (err) {
        throw new ServiceUnavailableError(
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
