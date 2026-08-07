import { AGENT_BIND_REJECT_REASONS, type AgentBindRejectReason, agentBindRequestSchema } from "@first-tree/shared";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { agents } from "../../../db/schema/agents.js";
import { clients } from "../../../db/schema/clients.js";
import { members } from "../../../db/schema/members.js";
import * as agentRuntimeSessionService from "../../../services/agent-runtime-session.js";
import * as connectionManager from "../../../services/connection-manager.js";
import * as inboxService from "../../../services/inbox.js";
import * as notificationService from "../../../services/notification.js";
import type { Notifier } from "../../../services/notifier.js";
import * as presenceService from "../../../services/presence.js";
import type { ClientWsConnectionContext } from "./connection-context.js";
import type { InboxDeliveryCoordinator } from "./inbox-delivery.js";

function sendRejected(socket: WebSocket, ref: string | undefined, reason: AgentBindRejectReason): void {
  socket.send(JSON.stringify({ type: "agent:bind:rejected", ref, reason }));
}

export async function handleAgentFrame(
  app: FastifyInstance,
  socket: WebSocket,
  notifier: Notifier,
  instanceId: string,
  context: ClientWsConnectionContext,
  inbox: InboxDeliveryCoordinator,
  type: string,
  msg: unknown,
  base: { agentId?: string; ref?: string },
): Promise<boolean | undefined> {
  const clientId = context.getClientId();
  const session = context.getSession();
  if (!session) return false;
  const ref = base.ref;
  const parsed = { data: base };
  const boundAgents = {
    has: context.hasBoundAgent,
    get: context.getBoundAgent,
    set: (_agentId: string, info: Parameters<typeof context.bindLocalAgent>[0]) => context.bindLocalAgent(info),
    delete: context.forgetLocalAgent,
  };
  if (type === "agent:bind") {
    if (!clientId) {
      socket.send(JSON.stringify({ type: "error", ref, message: "Must register client first" }));
      return;
    }

    const bindRequest = agentBindRequestSchema.parse(msg);
    const [bindingClient] = await app.db
      .select({ userId: clients.userId, retiredAt: clients.retiredAt })
      .from(clients)
      .where(eq(clients.id, clientId))
      .limit(1);
    if (!bindingClient || bindingClient.userId !== session.userId) {
      sendRejected(socket, ref, AGENT_BIND_REJECT_REASONS.NOT_OWNED);
      return;
    }
    if (bindingClient.retiredAt) {
      sendRejected(socket, ref, AGENT_BIND_REJECT_REASONS.WRONG_CLIENT);
      return;
    }

    const [agent] = await app.db
      .select({
        id: agents.uuid,
        displayName: agents.displayName,
        type: agents.type,
        organizationId: agents.organizationId,
        inboxId: agents.inboxId,
        status: agents.status,
        clientId: agents.clientId,
        managerId: agents.managerId,
        runtimeProvider: agents.runtimeProvider,
        clientUserId: clients.userId,
        managerUserId: members.userId,
        managerMemberStatus: members.status,
      })
      .from(agents)
      .leftJoin(clients, eq(agents.clientId, clients.id))
      .leftJoin(members, eq(agents.managerId, members.id))
      .where(and(eq(agents.uuid, bindRequest.agentId)))
      .limit(1);

    if (!agent) {
      sendRejected(socket, ref, AGENT_BIND_REJECT_REASONS.UNKNOWN_AGENT);
      return;
    }
    if (agent.status !== "active") {
      sendRejected(socket, ref, AGENT_BIND_REJECT_REASONS.AGENT_SUSPENDED);
      return;
    }

    // R-RUN owner check: same user AND manager's membership still
    // active. Multi-org under the same user is permitted — agent
    // org binding is not consulted (decouple-client-from-identity
    // §4.3). Membership flipped to inactive denies new binds while
    // already-bound agents continue running until unbind.
    const ownerOk = agent.managerUserId !== null && agent.managerUserId === session.userId;
    const membershipActive = agent.managerMemberStatus === "active";
    if (!ownerOk || !membershipActive) {
      sendRejected(socket, ref, AGENT_BIND_REJECT_REASONS.NOT_OWNED);
      return;
    }

    // Reject a runtime-provider mismatch BEFORE any first-bind claim.
    // The claim below is the one-shot NULL → ID that fixes an agent's
    // client for life (re-bind is removed), so a client running a
    // different runtime must never be allowed to pin an unbound agent
    // — otherwise it claims the agent, gets rejected here, and no
    // other client can recover it (they would only see WRONG_CLIENT).
    // The client repair path re-fetches authoritative state and
    // respawns the right handler before retrying the bind.
    if (bindRequest.runtimeType !== agent.runtimeProvider) {
      sendRejected(socket, ref, AGENT_BIND_REJECT_REASONS.RUNTIME_PROVIDER_MISMATCH);
      return;
    }

    // First-bind path: agent.clientId is NULL (e.g. created before
    // the operator brought up a client, or migrated from pre-M1 with
    // no presence record). The race-safe UPDATE returns 0 rows if
    // another bind claimed it first — surface as WRONG_CLIENT.
    //
    // The claim is also pinned to the `managerId` read above. A
    // concurrent leave/remove transfers a departing member's managed
    // agents by *changing* their `managerId` and clearing the pin, so
    // requiring the manager to be unchanged closes the departure race:
    // if the transfer already landed, the claim matches 0 rows and is
    // rejected instead of re-pinning the departed owner's client onto a
    // now-transferred agent (which would revive the retireClient
    // deadlock); if this claim lands first, the departure's
    // managerId-keyed transfer still re-scans and unpins it.
    if (agent.clientId === null) {
      const claim = await app.db
        .update(agents)
        .set({ clientId, updatedAt: new Date() })
        .where(
          and(
            eq(agents.uuid, agent.id),
            isNull(agents.clientId),
            eq(agents.managerId, agent.managerId),
            sql`EXISTS (
              SELECT 1 FROM ${clients}
              WHERE ${clients.id} = ${clientId}
                AND ${clients.userId} = ${session.userId}
                AND ${clients.retiredAt} IS NULL
            )`,
          ),
        )
        .returning({ uuid: agents.uuid });
      if (claim.length === 0) {
        sendRejected(socket, ref, AGENT_BIND_REJECT_REASONS.WRONG_CLIENT);
        return;
      }
    } else if (agent.clientId !== clientId) {
      sendRejected(socket, ref, AGENT_BIND_REJECT_REASONS.WRONG_CLIENT);
      return;
    } else if (!agent.clientUserId || agent.clientUserId !== session.userId) {
      sendRejected(socket, ref, AGENT_BIND_REJECT_REASONS.NOT_OWNED);
      return;
    }

    if (!connectionManager.isActiveClientConnection(clientId, socket)) {
      sendRejected(socket, ref, AGENT_BIND_REJECT_REASONS.WRONG_CLIENT);
      return;
    }

    let runtimeSessionToken: string;
    try {
      runtimeSessionToken = await agentRuntimeSessionService.bindAgentRuntimeSession(app.db, agent.id, clientId);
    } catch (err) {
      app.log.warn({ err, agentId: agent.id, clientId }, "agent:bind runtime session claim failed");
      sendRejected(socket, ref, AGENT_BIND_REJECT_REASONS.WRONG_CLIENT);
      return;
    }

    const published = await presenceService.bindAgentIfActiveClient(app.db, agent.id, {
      clientId,
      instanceId,
      runtimeType: bindRequest.runtimeType,
      runtimeVersion: bindRequest.runtimeVersion,
    });
    if (!published) {
      await agentRuntimeSessionService
        .revokeAgentRuntimeSessionIfTokenMatches(app.db, agent.id, clientId, runtimeSessionToken)
        .catch(() => {});
      sendRejected(socket, ref, AGENT_BIND_REJECT_REASONS.WRONG_CLIENT);
      return;
    }

    if (!connectionManager.isActiveClientConnection(clientId, socket)) {
      const revoked = await agentRuntimeSessionService
        .revokeAgentRuntimeSessionIfTokenMatches(app.db, agent.id, clientId, runtimeSessionToken)
        .catch(() => false);
      if (revoked && connectionManager.getAgentClientId(agent.id) !== clientId) {
        await presenceService.unbindAgent(app.db, agent.id, { expectedClientId: clientId }).catch(() => {});
      }
      sendRejected(socket, ref, AGENT_BIND_REJECT_REASONS.WRONG_CLIENT);
      return;
    }

    // An agent that just rebound has, by definition, recovered from
    // whatever fault (stale / error / blocked) was last reported —
    // close any open unread fault row so the bell badge clears
    // instead of lingering across the offline gap.
    notificationService.markAgentFaultsResolved(app.db, agent.id).catch(() => {});

    connectionManager.bindAgentToClient(clientId, agent.id, runtimeSessionToken);
    inbox.clearRecoverProgress(agent.id);
    boundAgents.set(agent.id, {
      agentId: agent.id,
      inboxId: agent.inboxId,
      organizationId: agent.organizationId,
      runtimeProvider: agent.runtimeProvider,
    });

    // In-flight recovery: a freshly-(re)connected client may not
    // have acked entries the previous socket received before it
    // dropped (process crash, network blip, etc.). Reset every
    // `delivered` row for this inbox back to `pending` so the
    // follow-up `drainBacklogForAgent` re-pushes them. This must
    // complete before `agent:bound`: clients clear their local
    // bind-recovery guard when they observe that frame.
    try {
      const reset = await inboxService.resetDeliveredForInboxes(app.db, [agent.inboxId]);
      if (reset > 0) {
        app.log.info(
          { agentId: agent.id, inboxId: agent.inboxId, reset },
          "agent:bind reset delivered → pending for in-flight recovery",
        );
      }
    } catch (err) {
      // Not fatal — drain still runs against whatever is pending.
      // Genuinely-stuck delivered rows will be picked up by the
      // next bind.
      app.log.error({ err, agentId: agent.id, inboxId: agent.inboxId }, "agent:bind resetDeliveredForInboxes failed");
    }

    // Subscribe to NOTIFY traffic with a per-socket push handler so
    // NOTIFYs land as `inbox:deliver` frames on this connection.
    notifier.subscribe(agent.inboxId, socket, inbox.makePushHandler(agent.id, agent.inboxId));

    socket.send(
      JSON.stringify({
        type: "agent:bound",
        ref,
        agentId: agent.id,
        displayName: agent.displayName,
        agentType: agent.type,
        runtimeSessionToken,
      }),
    );

    // Reconnect/recovery: drain any pending entries that piled up
    // while this socket was offline (or while another instance held
    // the subscription), plus everything the bind-time reset above
    // just flipped from `delivered` to `pending`. Failures are
    // logged inside the helper — don't crash the bind path.
    inbox
      .chainDelivery(agent.id, () => inbox.drainBacklog(agent.id, agent.inboxId, { source: "bind" }))
      .catch((err) => {
        app.log.error({ err, agentId: agent.id }, "post-bind backlog drain crashed");
      });
  } else if (type === "agent:unbind") {
    const agentId = parsed.data.agentId;
    if (!agentId || !boundAgents.has(agentId)) {
      socket.send(JSON.stringify({ type: "error", message: "Agent not bound" }));
      return;
    }

    const info = boundAgents.get(agentId);
    const stillRoutedHere = await context.ensureAgentStillRoutedHere(agentId);
    if (info) {
      notifier.unsubscribe(info.inboxId, socket);
    }

    if (stillRoutedHere && clientId) {
      await agentRuntimeSessionService.revokeAgentRuntimeSession(app.db, agentId, clientId);
      await presenceService.unbindAgent(app.db, agentId, { expectedClientId: clientId });
      connectionManager.unbindAgentFromClient(agentId, clientId);
    } else {
      app.log.info({ clientId, agentId }, "stale agent:unbind ignored for global binding");
    }
    boundAgents.delete(agentId);
    inbox.clearAfterUnbind(agentId);

    socket.send(JSON.stringify({ type: "agent:unbound", agentId }));
  } else return false;
  return true;
}
