import {
  type InboxEntryWithMessage,
  inboxAckFrameSchema,
  inboxDeliverFrameSchema,
  inboxFenceProbeFrameSchema,
  inboxRecoverFrameSchema,
} from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import * as inboxService from "../../../services/inbox.js";
import type { InboxPushHandler } from "../../../services/notifier.js";
import type { ClientWsConnectionContext } from "./connection-context.js";

const INBOX_BACKLOG_BATCH_LIMIT = 50;
const INBOX_BACKLOG_REPAIR_INTERVAL_MS = 30_000;
const INBOX_RECOVER_NO_PROGRESS_LIMIT = 2;

export type InboxDeliveryCoordinator = ReturnType<typeof createInboxDeliveryCoordinator>;

export function createInboxDeliveryCoordinator(
  app: FastifyInstance,
  socket: WebSocket,
  context: ClientWsConnectionContext,
  inboxMaxInFlightPerAgent: number,
  inboxMaxInFlightPerAgentChat: number,
) {
  type InboxInFlightChatBucket = {
    chatId: string | null;
    entryIds: Set<number>;
  };
  type InboxInFlightOwner = {
    agentId: string;
    chatKey: string;
  };

  /**
   * Per-socket in-flight `inbox:deliver` ids for backpressure. Tracking ids
   * instead of scalar counters lets ACK and same-socket recovery remove
   * exactly the reset rows before redelivery, so the cap cannot leak when
   * an entry is delivered twice on the same connection.
   */
  const inboxInFlightByAgent = new Map<string, Map<string, InboxInFlightChatBucket>>();
  const inboxInFlightOwnersByEntryId = new Map<number, InboxInFlightOwner>();
  /**
   * Socket-wide inbox operation queue. This is intentionally stronger than
   * per-agent delivery serialization: `inbox:ack` does not carry an
   * agentId, so putting ACK DB updates, recovery resets, and delivery
   * drains in one FIFO is the simple way to preserve WS frame order for
   * the ACK/recover race.
   */
  let inboxOperationQueue: Promise<void> = Promise.resolve();
  const lastInboxRepairDrainAtByAgent = new Map<string, number>();
  type InboxRecoverProgress = {
    resetSignature: string;
    consecutiveResets: number;
    open: boolean;
  };
  const inboxRecoverProgress = new Map<string, InboxRecoverProgress>();

  function inboxRecoverProgressKey(agentId: string, chatId: string): string {
    return `${agentId}\u0000${chatId}`;
  }

  function clearInboxRecoverProgress(agentId: string, chatId?: string): void {
    if (chatId !== undefined) {
      inboxRecoverProgress.delete(inboxRecoverProgressKey(agentId, chatId));
      return;
    }
    const prefix = `${agentId}\u0000`;
    for (const key of inboxRecoverProgress.keys()) {
      if (key.startsWith(prefix)) inboxRecoverProgress.delete(key);
    }
  }

  function inboxInFlightCount(agentId: string): number {
    const byChat = inboxInFlightByAgent.get(agentId);
    if (!byChat) return 0;
    let total = 0;
    for (const bucket of byChat.values()) total += bucket.entryIds.size;
    return total;
  }

  function inboxChatKey(chatId: string | null): string {
    return chatId === null ? "null" : `chat:${chatId}`;
  }

  function inboxInFlightCountForChat(agentId: string, chatId: string | null): number {
    return inboxInFlightByAgent.get(agentId)?.get(inboxChatKey(chatId))?.entryIds.size ?? 0;
  }

  function inboxInFlightChatBudgets(agentId: string): Array<{ chatId: string | null; remaining: number }> {
    const budgets = new Map<string, { chatId: string | null; remaining: number }>();
    const byChat = inboxInFlightByAgent.get(agentId);
    if (byChat) {
      for (const bucket of byChat.values()) {
        budgets.set(inboxChatKey(bucket.chatId), {
          chatId: bucket.chatId,
          remaining: Math.max(0, inboxMaxInFlightPerAgentChat - bucket.entryIds.size),
        });
      }
    }
    // A chat whose same-socket no-progress circuit is open must stay
    // ineligible for every normal notify/repair/ACK fair drain on this
    // socket, not just for scoped recover; only that chat's ACK or a
    // fresh bind (both clear the circuit) may release its held debt.
    // The zero budget overrides any ordinary in-flight remainder while
    // other chats keep draining normally.
    const circuitPrefix = `${agentId}\u0000`;
    for (const [key, progress] of inboxRecoverProgress) {
      if (!progress.open || !key.startsWith(circuitPrefix)) continue;
      const chatId = key.slice(circuitPrefix.length);
      budgets.set(inboxChatKey(chatId), { chatId, remaining: 0 });
    }
    return [...budgets.values()];
  }

  function logPerChatCaps(agentId: string, inboxId: string, inFlightCount: number): void {
    const byChat = inboxInFlightByAgent.get(agentId);
    if (!byChat) return;
    for (const bucket of byChat.values()) {
      if (bucket.entryIds.size < inboxMaxInFlightPerAgentChat) continue;
      app.log.debug(
        {
          agentId,
          inboxId,
          chatId: bucket.chatId,
          inFlightCount,
          chatInFlightCount: bucket.entryIds.size,
          globalCap: inboxMaxInFlightPerAgent,
          chatCap: inboxMaxInFlightPerAgentChat,
        },
        "inbox push: per-chat cap active, skipping capped chat backlog",
      );
    }
  }

  function removeInboxInFlight(entryIds: readonly number[]): void {
    for (const entryId of entryIds) {
      const owner = inboxInFlightOwnersByEntryId.get(entryId);
      if (!owner) continue;
      const byChat = inboxInFlightByAgent.get(owner.agentId);
      const bucket = byChat?.get(owner.chatKey);
      bucket?.entryIds.delete(entryId);
      inboxInFlightOwnersByEntryId.delete(entryId);
      if (bucket && bucket.entryIds.size === 0) byChat?.delete(owner.chatKey);
      if (byChat && byChat.size === 0) inboxInFlightByAgent.delete(owner.agentId);
    }
  }

  function addInboxInFlight(agentId: string, chatId: string | null, entryId: number): void {
    removeInboxInFlight([entryId]);
    const chatKey = inboxChatKey(chatId);
    const byChat = inboxInFlightByAgent.get(agentId) ?? new Map<string, InboxInFlightChatBucket>();
    const bucket = byChat.get(chatKey) ?? { chatId, entryIds: new Set<number>() };
    bucket.entryIds.add(entryId);
    byChat.set(chatKey, bucket);
    inboxInFlightByAgent.set(agentId, byChat);
    inboxInFlightOwnersByEntryId.set(entryId, { agentId, chatKey });
  }

  function clearInboxInFlightForAgent(agentId: string): void {
    const byChat = inboxInFlightByAgent.get(agentId);
    if (!byChat) return;
    for (const bucket of byChat.values()) {
      for (const entryId of bucket.entryIds) inboxInFlightOwnersByEntryId.delete(entryId);
    }
    inboxInFlightByAgent.delete(agentId);
  }

  function chainInboxDelivery(_agentId: string, op: () => Promise<void>): Promise<void> {
    const prev = inboxOperationQueue;
    const next = prev.then(op, op);
    inboxOperationQueue = next.catch(() => {});
    return next;
  }

  /**
   * Returns `false` when the socket has already moved out of `OPEN` —
   * the only failure mode the caller can observe synchronously.
   *
   * Note: `ws.send` is fire-and-forget; a buffered frame that fails
   * to actually flush (TCP slow-close, internal queue full) does NOT
   * surface here. That class of loss is recovered when the client
   * reconnects: `agent:bind` resets every still-`delivered` row back
   * to `pending` before draining (see
   * docs/inflight-message-recovery-design.md §4). If you ever need
   * flush-level confirmation, switch to the `ws.send(frame, cb)`
   * callback form (see `notifier.ts pushFrameToInbox`).
   */
  function sendInboxDeliverFrame(entry: InboxEntryWithMessage): boolean {
    if (socket.readyState !== socket.OPEN) return false;
    const frame = {
      type: "inbox:deliver",
      entryId: entry.id,
      inboxId: entry.inboxId,
      chatId: entry.chatId,
      message: entry.message,
    };
    // Self-validate the wire shape against the same schema the client
    // applies. A failure here means the server has serialised something
    // the client will reject — log loudly so a schema-drift bug surfaces
    // server-side instead of getting stuck behind the client's silent
    // drop. We still send the frame: client also logs the issue, and
    // dropping here unilaterally would leave the entry as `delivered`
    // forever (unable to ack on a frame the client never saw).
    const validated = inboxDeliverFrameSchema.safeParse(frame);
    if (!validated.success) {
      app.log.error(
        {
          entryId: entry.id,
          inboxId: entry.inboxId,
          issues: validated.error.issues.map((i) => ({
            path: i.path.join("."),
            code: i.code,
            message: i.message,
          })),
        },
        "inbox:deliver frame failed self-validation — wire shape drift",
      );
    }
    socket.send(JSON.stringify(frame));
    return true;
  }

  /**
   * Build the per-socket push handler bound to a specific agent. A NOTIFY
   * is only a wake-up hint; the handler drains pending backlog oldest-first
   * instead of exact-claiming the notified messageId. The per-agent delivery
   * queue above serializes claim+send so two NOTIFYs cannot reorder same-chat
   * frames before the client records attempt membership.
   */
  function makeInboxPushHandler(agentId: string, inboxId: string): InboxPushHandler {
    return (messageId: string) =>
      chainInboxDelivery(agentId, () => drainBacklogForAgent(agentId, inboxId, { source: "notify", messageId }));
  }

  function maybeRepairInboxBacklog(agentId: string, inboxId: string): void {
    if (socket.readyState !== socket.OPEN) return;
    if (!context.isAgentStillRoutedHere(agentId)) return;

    const now = Date.now();
    const lastRepairAt = lastInboxRepairDrainAtByAgent.get(agentId) ?? 0;
    if (now - lastRepairAt < INBOX_BACKLOG_REPAIR_INTERVAL_MS) return;
    lastInboxRepairDrainAtByAgent.set(agentId, now);

    chainInboxDelivery(agentId, () => drainBacklogForAgent(agentId, inboxId, { source: "repair" })).catch((err) => {
      app.log.error({ err, agentId, inboxId }, "inbox backlog repair crashed");
    });
  }

  /**
   * Drain up to `INBOX_BACKLOG_BATCH_LIMIT` pending entries for an agent
   * over the current WS. Normal scheduling is capped by the per-chat
   * fairness window; the agent-wide cap is only a high-water fuse.
   *
   * Used in four places:
   *   1. Right after `agent:bound` — covers reconnects where NOTIFYs
   *      were dropped while the socket was offline.
   *   2. Right after an `inbox:ack` — top up the in-flight slot just
   *      freed, in case the previous NOTIFY was dropped at-cap.
   *   3. On `inbox:recover` — reset and redeliver one chat's unacked
   *      recovery debt.
   *   4. Low-frequency bound-socket repair — drains durable pending
   *      notify rows when PG NOTIFY was missed but the socket stayed up.
   *
   * Delivery operations are serialized on the socket, so budget checks and the
   * subsequent claim/send loop observe one consistent per-socket in-flight
   * counter. That ordering is part of the ack-through safety contract.
   */
  async function drainBacklogForAgent(
    agentId: string,
    inboxId: string,
    trigger?:
      | { source: "notify"; messageId: string }
      | { source: "bind" | "ack" | "repair" }
      | { source: "recover"; chatId: string },
  ): Promise<void> {
    if (socket.readyState !== socket.OPEN) return;
    if (!(await context.ensureAgentStillRoutedHere(agentId))) return;
    const inFlight = inboxInFlightCount(agentId);
    const globalSlotsFree = inboxMaxInFlightPerAgent - inFlight;
    if (globalSlotsFree <= 0) {
      app.log.warn(
        {
          agentId,
          inboxId,
          chatId: trigger?.source === "recover" ? trigger.chatId : null,
          messageId: trigger?.source === "notify" ? trigger.messageId : undefined,
          inFlightCount: inFlight,
          chatInFlightCount:
            trigger?.source === "recover" ? inboxInFlightCountForChat(agentId, trigger.chatId) : undefined,
          globalCap: inboxMaxInFlightPerAgent,
          chatCap: inboxMaxInFlightPerAgentChat,
        },
        "inbox push: global in-flight fuse reached, leaving backlog pending",
      );
      return;
    }
    logPerChatCaps(agentId, inboxId, inFlight);

    const recoverChatId = trigger?.source === "recover" ? trigger.chatId : undefined;
    const limit =
      recoverChatId === undefined
        ? Math.min(globalSlotsFree, INBOX_BACKLOG_BATCH_LIMIT)
        : Math.min(
            globalSlotsFree,
            Math.max(0, inboxMaxInFlightPerAgentChat - inboxInFlightCountForChat(agentId, recoverChatId)),
            INBOX_BACKLOG_BATCH_LIMIT,
          );
    if (limit <= 0) {
      if (recoverChatId !== undefined) {
        app.log.debug(
          {
            agentId,
            inboxId,
            chatId: recoverChatId,
            inFlightCount: inFlight,
            chatInFlightCount: inboxInFlightCountForChat(agentId, recoverChatId),
            globalCap: inboxMaxInFlightPerAgent,
            chatCap: inboxMaxInFlightPerAgentChat,
          },
          "inbox push: recovery chat at per-chat cap, leaving backlog pending",
        );
      }
      return;
    }

    let entries: InboxEntryWithMessage[];
    try {
      entries =
        trigger?.source === "recover"
          ? await inboxService.claimBacklogForPushForChat(app.db, inboxId, trigger.chatId, limit)
          : await inboxService.claimBacklogForPushFair(app.db, inboxId, {
              limit,
              defaultPerChatLimit: inboxMaxInFlightPerAgentChat,
              chatBudgets: inboxInFlightChatBudgets(agentId),
            });
    } catch (err) {
      app.log.error({ err, agentId, inboxId, limit }, "claim backlog for WS push failed");
      return;
    }

    if (trigger?.source === "repair" && entries.length > 0) {
      app.log.info(
        {
          source: "repair",
          agentId,
          inboxId,
          drained: entries.length,
          inFlightCount: inFlight,
          globalCap: inboxMaxInFlightPerAgent,
          chatCap: inboxMaxInFlightPerAgentChat,
        },
        "inbox backlog repair drained pending notify rows",
      );
    }

    for (const entry of entries) {
      addInboxInFlight(agentId, entry.chatId, entry.id);
      if (!sendInboxDeliverFrame(entry)) {
        removeInboxInFlight([entry.id]);
        // Socket gone mid-drain — stop pushing. Remaining entries stay
        // 'delivered'; the next bind from this client resets them and
        // re-drains.
        return;
      }
    }
  }

  function clearAgent(agentId: string): void {
    lastInboxRepairDrainAtByAgent.delete(agentId);
    clearInboxRecoverProgress(agentId);
    clearInboxInFlightForAgent(agentId);
  }

  function clearAfterUnbind(agentId: string): void {
    lastInboxRepairDrainAtByAgent.delete(agentId);
    clearInboxInFlightForAgent(agentId);
  }

  function clearState(): void {
    lastInboxRepairDrainAtByAgent.clear();
    inboxRecoverProgress.clear();
    inboxInFlightByAgent.clear();
    inboxInFlightOwnersByEntryId.clear();
  }

  async function handleFrame(type: string, msg: unknown): Promise<boolean | undefined> {
    const clientId = context.getClientId();
    const boundAgents = {
      values: context.boundAgentValues,
      get: context.getBoundAgent,
    };
    if (type === "inbox:ack") {
      const payloadResult = inboxAckFrameSchema.safeParse(msg);
      if (!payloadResult.success) {
        // Server-side log so a buggy / malicious client's malformed
        // frames are visible in trace backends even when the client
        // discards the error reply. Wire-shape drift between
        // client and server schemas is the most common cause.
        app.log.warn(
          {
            clientId,
            issues: payloadResult.error.issues.map((i) => ({
              path: i.path.join("."),
              code: i.code,
              message: i.message,
            })),
          },
          "malformed inbox:ack frame — replying error",
        );
        socket.send(JSON.stringify({ type: "error", message: "Malformed inbox:ack frame" }));
        return;
      }
      const { entryId, ref } = payloadResult.data;

      await chainInboxDelivery("__socket", async () => {
        try {
          const routedBoundAgents = [];
          for (const agent of boundAgents.values()) {
            if (await context.ensureAgentStillRoutedHere(agent.agentId)) {
              routedBoundAgents.push(agent);
            }
          }
          const ackResult = await inboxService.ackEntryByIdForBoundAgents(
            app.db,
            entryId,
            routedBoundAgents.map((a) => a.inboxId),
          );
          if (!ackResult.ok) {
            if (ref) {
              socket.send(
                JSON.stringify({
                  type: "inbox:ack:rejected",
                  entryId,
                  ref,
                  reason: ackResult.reason,
                }),
              );
            }
            app.log.debug(
              {
                clientId,
                entryId,
                ref,
                agentId: null,
                boundInboxes: routedBoundAgents.length,
                reason: ackResult.reason,
                ackEvent: "inbox_ack_rejected",
              },
              "inbox:ack rejected",
            );
            return;
          }
          // Find the agentId that owns this inbox to decrement the
          // counter and trigger backlog drain.
          const owner = routedBoundAgents.find((a) => a.inboxId === ackResult.throughEntry.inboxId);
          if (ref) {
            socket.send(
              JSON.stringify({
                type: "inbox:ack:accepted",
                entryId,
                ref,
                disposition: ackResult.disposition,
                ackedCount: ackResult.ackedCount,
              }),
            );
          }
          app.log.debug(
            {
              clientId,
              entryId,
              ref,
              agentId: owner?.agentId ?? null,
              disposition: ackResult.disposition,
              ackedCount: ackResult.ackedCount,
              ackedEntryIds: ackResult.ackedEntryIds,
              ackEvent: "inbox_ack_accepted",
            },
            "inbox:ack accepted",
          );
          if (owner && ackResult.ackedEntryIds.length > 0) {
            if (typeof ackResult.throughEntry.chatId === "string") {
              clearInboxRecoverProgress(owner.agentId, ackResult.throughEntry.chatId);
            }
            removeInboxInFlight(ackResult.ackedEntryIds);
            // Slot freed → top up. Cheap when no backlog (single SQL
            // statement returning 0 rows). Critical when the cap was
            // hit and queued NOTIFYs got dropped (proposal §3.5).
            await drainBacklogForAgent(owner.agentId, owner.inboxId, { source: "ack" });
          }
        } catch (err) {
          app.log.error({ err, entryId }, "inbox:ack handling failed");
        }
      });
    } else if (type === "inbox:recover") {
      const payloadResult = inboxRecoverFrameSchema.safeParse(msg);
      if (!payloadResult.success) {
        app.log.warn(
          {
            clientId,
            issues: payloadResult.error.issues.map((i) => ({
              path: i.path.join("."),
              code: i.code,
              message: i.message,
            })),
          },
          "malformed inbox:recover frame — replying error",
        );
        socket.send(JSON.stringify({ type: "error", message: "Malformed inbox:recover frame" }));
        return;
      }
      const { agentId, chatId, ref } = payloadResult.data;
      await chainInboxDelivery("__socket", async () => {
        const info = boundAgents.get(agentId);
        if (!info || !(await context.ensureAgentStillRoutedHere(agentId))) {
          socket.send(
            JSON.stringify({
              type: "inbox:recover:rejected",
              ref,
              agentId,
              chatId,
              reason: "agent_not_bound",
            }),
          );
          return;
        }

        try {
          const progressKey = inboxRecoverProgressKey(agentId, chatId);
          const priorProgress = inboxRecoverProgress.get(progressKey);
          if (priorProgress?.open) {
            socket.send(
              JSON.stringify({
                type: "inbox:recover:rejected",
                ref,
                agentId,
                chatId,
                reason: "recover_failed",
              }),
            );
            app.log.warn(
              {
                agentId,
                chatId,
                resetSignature: priorProgress.resetSignature,
                consecutiveResets: priorProgress.consecutiveResets,
                recoverEvent: "inbox_recover_no_progress_blocked",
              },
              "inbox:recover blocked after repeated no-progress resets",
            );
            return;
          }

          const recovered = await inboxService.recoverUnackedForScope(app.db, {
            inboxId: info.inboxId,
            chatId,
          });
          removeInboxInFlight(recovered.resetEntryIds);
          if (recovered.resetEntryIds.length > 0) {
            const resetSignature = [...recovered.resetEntryIds].sort((a, b) => a - b).join(",");
            const consecutiveResets =
              priorProgress?.resetSignature === resetSignature ? priorProgress.consecutiveResets + 1 : 1;
            if (consecutiveResets > INBOX_RECOVER_NO_PROGRESS_LIMIT) {
              inboxRecoverProgress.set(progressKey, {
                resetSignature,
                consecutiveResets,
                open: true,
              });
              socket.send(
                JSON.stringify({
                  type: "inbox:recover:rejected",
                  ref,
                  agentId,
                  chatId,
                  reason: "recover_failed",
                }),
              );
              app.log.warn(
                {
                  agentId,
                  chatId,
                  resetEntryIds: recovered.resetEntryIds,
                  consecutiveResets,
                  recoverEvent: "inbox_recover_no_progress_opened",
                },
                "inbox:recover opened no-progress circuit; backlog remains pending until ACK or bind",
              );
              return;
            }
            inboxRecoverProgress.set(progressKey, {
              resetSignature,
              consecutiveResets,
              open: false,
            });
          } else {
            inboxRecoverProgress.delete(progressKey);
          }
          // Counted inside the same serialized chain as the reset:
          // unacked rows may already be `pending` (bind reset), so
          // only pending+delivered = 0 proves the chat settled.
          const unackedOutstanding = await inboxService.countUnackedForScope(app.db, {
            inboxId: info.inboxId,
            chatId,
          });
          socket.send(
            JSON.stringify({
              type: "inbox:recover:accepted",
              ref,
              agentId,
              chatId,
              resetCount: recovered.resetEntryIds.length,
              unackedOutstanding,
            }),
          );
          await drainBacklogForAgent(agentId, info.inboxId, { source: "recover", chatId });
        } catch (err) {
          app.log.error({ err, agentId, chatId }, "inbox:recover handling failed");
          socket.send(
            JSON.stringify({
              type: "inbox:recover:rejected",
              ref,
              agentId,
              chatId,
              reason: "recover_failed",
            }),
          );
        }
      });
    } else if (type === "inbox:fence-probe") {
      const payloadResult = inboxFenceProbeFrameSchema.safeParse(msg);
      if (!payloadResult.success) {
        app.log.warn(
          {
            clientId,
            issues: payloadResult.error.issues.map((i) => ({
              path: i.path.join("."),
              code: i.code,
              message: i.message,
            })),
          },
          "malformed inbox:fence-probe frame — replying error",
        );
        socket.send(JSON.stringify({ type: "error", message: "Malformed inbox:fence-probe frame" }));
        return;
      }
      const { agentId, chatId, ref, messageIds } = payloadResult.data;
      // Read-only settlement probe, but serialized through the same
      // boundary as recovery so the answer is consistent with any
      // concurrent reset/drain.
      await chainInboxDelivery("__socket", async () => {
        const info = boundAgents.get(agentId);
        if (!info || !(await context.ensureAgentStillRoutedHere(agentId))) {
          socket.send(
            JSON.stringify({
              type: "inbox:fence-probe:rejected",
              ref,
              agentId,
              chatId,
              reason: "agent_not_bound",
            }),
          );
          return;
        }
        try {
          const settledMessageIds = await inboxService.listSettledMessageIdsForScope(app.db, {
            inboxId: info.inboxId,
            chatId,
            messageIds,
          });
          socket.send(
            JSON.stringify({
              type: "inbox:fence-probe:accepted",
              ref,
              agentId,
              chatId,
              settledMessageIds,
            }),
          );
        } catch (err) {
          app.log.error({ err, agentId, chatId }, "inbox:fence-probe handling failed");
          socket.send(
            JSON.stringify({
              type: "inbox:fence-probe:rejected",
              ref,
              agentId,
              chatId,
              reason: "recover_failed",
            }),
          );
        }
      });
    } else return false;
    return true;
  }

  return {
    handleFrame,
    clearAgent,
    clearAfterUnbind,
    clearState,
    clearRecoverProgress: clearInboxRecoverProgress,
    chainDelivery: chainInboxDelivery,
    drainBacklog: drainBacklogForAgent,
    makePushHandler: makeInboxPushHandler,
    maybeRepair: maybeRepairInboxBacklog,
  };
}
