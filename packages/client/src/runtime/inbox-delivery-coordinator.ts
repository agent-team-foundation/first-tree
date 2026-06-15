import type { InboxEntryWithMessage } from "@first-tree/shared";
import type { pino } from "../observability/logger.js";
import { Deduplicator } from "./deduplicator.js";
import type { SessionMessage, TurnOutcome } from "./handler.js";

export type DeliveryWork = {
  chatId: string;
  entryId: number;
  messageId: string;
};

export type DeliveryDecision =
  | { kind: "deliver"; work: DeliveryWork }
  | { kind: "duplicate-in-flight" }
  | { kind: "recovering" };

export type WorkSnapshot = {
  entries: Array<{
    entryId: number;
    messageId: string;
    phase: DeliveryPhase;
  }>;
  recoveryDebt: RecoveryDebt;
  admissionPending: boolean;
};

type DeliveryPhase = "tracked" | "accepted" | "consumed" | "ackPending";
type RecoveryDebt = "none" | "required" | "running";

type TrackedDelivery = {
  entryId: number;
  messageId: string;
  dedupKey: string;
  phase: DeliveryPhase;
};

type ChatInboxLedger = {
  entries: TrackedDelivery[];
  recoveryDebt: RecoveryDebt;
  recoveryActivationReady: boolean;
  // Server recovery can redeliver several frames after one accepted request;
  // keep classifying that burst as recovery while any redelivered work is unsettled.
  recoveryWindowOpen: boolean;
  admissionQueue: Promise<void> | null;
  ackQueue: Promise<void> | null;
};

type InboxDeliveryCoordinatorConfig = {
  ackEntry: (entryId: number) => Promise<void>;
  recoverChat?: (chatId: string) => Promise<void>;
  onWorkChanged: (chatId: string) => void;
  log: pino.Logger;
};

export class InboxDeliveryCoordinator {
  private readonly config: InboxDeliveryCoordinatorConfig;
  private readonly deduplicator = new Deduplicator(1000);
  private readonly ledgers = new Map<string, ChatInboxLedger>();
  private readonly recoveringChats = new Map<string, Promise<void>>();

  constructor(config: InboxDeliveryCoordinatorConfig) {
    this.config = config;
  }

  receive(entry: InboxEntryWithMessage): DeliveryDecision {
    const chatId = entry.chatId ?? entry.message.chatId;
    const messageId = entry.message.id;
    const ledger = this.ledger(chatId);

    if (ledger.recoveryDebt !== "none") {
      return { kind: "recovering" };
    }

    const dedupKey = this.dedupKey(chatId, messageId);
    if (this.deduplicator.isDuplicate(dedupKey)) {
      const stillInFlight = ledger.entries.some((tracked) => tracked.entryId === entry.id);
      this.config.log.debug({ chatId, messageId, entryId: entry.id, stillInFlight }, "duplicate message observed");
      if (stillInFlight) return { kind: "duplicate-in-flight" };
      this.config.log.debug(
        { chatId, messageId, entryId: entry.id },
        "duplicate key is not tied to an active entry; reprocessing redelivery",
      );
    }

    ledger.entries.push({ entryId: entry.id, messageId, dedupKey, phase: "tracked" });
    ledger.entries.sort((a, b) => a.entryId - b.entryId);
    this.emitWorkChanged(chatId);
    return { kind: "deliver", work: { chatId, entryId: entry.id, messageId } };
  }

  shouldRecoverBeforeDispatch(chatId: string, hasHealthyLiveHandler: boolean, hasLocalSessionRecord: boolean): boolean {
    const ledger = this.ledgers.get(chatId);
    if (ledger?.recoveryActivationReady) return false;
    if (ledger?.recoveryDebt === "required" || ledger?.recoveryDebt === "running") return true;
    return Boolean(this.config.recoverChat) && hasLocalSessionRecord && !hasHealthyLiveHandler;
  }

  takeRecoveryActivationReady(chatId: string): boolean {
    const ledger = this.ledgers.get(chatId);
    if (!ledger) return false;
    if (ledger.recoveryActivationReady) {
      ledger.recoveryActivationReady = false;
      ledger.recoveryWindowOpen = true;
      return true;
    }
    return ledger.recoveryWindowOpen && this.hasUnsettledWork(chatId);
  }

  async recoverIfNeeded(chatId: string, reason: string): Promise<void> {
    await this.requestRecovery(chatId, reason);
  }

  private async requestRecovery(chatId: string, reason: string): Promise<void> {
    const existing = this.recoveringChats.get(chatId);
    if (existing) {
      await existing;
      return;
    }

    const recoverChat = this.config.recoverChat;
    const ledger = this.ledger(chatId);
    if (!recoverChat) {
      ledger.recoveryDebt = "required";
      this.emitWorkChanged(chatId);
      this.config.log.error(
        { chatId, reason },
        "chat requires inbox recovery but no recoverChat callback is configured",
      );
      return;
    }

    ledger.recoveryDebt = "running";
    this.emitWorkChanged(chatId);

    let recovery: Promise<void>;
    recovery = recoverChat(chatId)
      .then(() => {
        this.clearEntriesForRecoverySuccess(chatId);
        const current = this.ledger(chatId);
        current.recoveryDebt = "none";
        current.recoveryActivationReady = true;
        current.recoveryWindowOpen = false;
        this.config.log.debug({ chatId, reason }, "chat inbox recovery accepted before dispatch");
      })
      .catch((err) => {
        const current = this.ledger(chatId);
        current.recoveryDebt = "required";
        this.config.log.warn({ chatId, reason, err }, "chat inbox recovery failed before dispatch");
      })
      .finally(() => {
        if (this.recoveringChats.get(chatId) === recovery) this.recoveringChats.delete(chatId);
        this.emitWorkChanged(chatId);
      });

    this.recoveringChats.set(chatId, recovery);
    await recovery;
  }

  async runAdmission<T>(work: DeliveryWork, op: () => Promise<T>): Promise<T> {
    const ledger = this.ledger(work.chatId);
    const prev = ledger.admissionQueue ?? Promise.resolve();
    const next = prev.then(op, op);
    const queueMarker = next.then(
      () => {},
      () => {},
    );
    ledger.admissionQueue = queueMarker;
    this.emitWorkChanged(work.chatId);
    const cleanup = () => {
      if (ledger.admissionQueue === queueMarker) {
        ledger.admissionQueue = null;
        this.cleanupLedger(work.chatId);
        this.emitWorkChanged(work.chatId);
      }
    };
    void next.then(cleanup, cleanup);
    return next;
  }

  markAccepted(work: DeliveryWork): boolean {
    const tracked = this.findEntry(work.chatId, work.entryId);
    if (!tracked) return false;
    if (tracked.phase === "tracked") {
      tracked.phase = "accepted";
      this.emitWorkChanged(work.chatId);
    }
    return true;
  }

  hasEntry(work: DeliveryWork): boolean {
    return this.findEntry(work.chatId, work.entryId) !== null;
  }

  markConsumed(chatId: string, messages: SessionMessage | readonly SessionMessage[]): void {
    const ledger = this.ledgers.get(chatId);
    if (!ledger || ledger.entries.length === 0) return;
    const consumedIds = this.messageEntryIds(chatId, messages);
    if (consumedIds.size === 0) return;
    let changed = false;
    for (const tracked of ledger.entries) {
      if (!consumedIds.has(tracked.entryId)) continue;
      if (tracked.phase === "tracked" || tracked.phase === "accepted") {
        tracked.phase = "consumed";
        changed = true;
      }
    }
    if (changed) this.emitWorkChanged(chatId);
  }

  async finishTurn(
    chatId: string,
    messages: SessionMessage | readonly SessionMessage[],
    _outcome: TurnOutcome,
  ): Promise<void> {
    this.markConsumed(chatId, messages);
    const throughEntryId = this.lastMessageEntryId(chatId, messages);
    if (throughEntryId === undefined) {
      this.config.log.warn({ chatId }, "turn completion ignored because no inboxEntryId was provided");
      return;
    }
    await this.ackThrough(chatId, throughEntryId, "finish_turn", { requireConsumedPrefix: true });
  }

  retryTurn(chatId: string, messages: SessionMessage | readonly SessionMessage[], reason: string): void {
    const entryIds = this.messageEntryIds(chatId, messages);
    if (entryIds.size === 0) return;
    const ledger = this.ledgers.get(chatId);
    if (!ledger?.entries.some((entry) => entryIds.has(entry.entryId))) return;
    void this.markRecoveryDebt(chatId, reason);
  }

  async prepareSuspend(chatId: string, reason: string): Promise<void> {
    const ledger = this.ledgers.get(chatId);
    if (!ledger || ledger.entries.length === 0) return;

    let consumedPrefixCount = 0;
    for (const tracked of ledger.entries) {
      if (tracked.phase !== "consumed" && tracked.phase !== "ackPending") break;
      consumedPrefixCount++;
    }

    if (consumedPrefixCount > 0) {
      const lastConsumed = ledger.entries[consumedPrefixCount - 1];
      if (lastConsumed) {
        await this.ackThrough(chatId, lastConsumed.entryId, `${reason}:consumed_prefix`, {
          requireConsumedPrefix: true,
        });
      }
    }

    const remaining = this.ledgers.get(chatId)?.entries ?? [];
    if (remaining.length > 0) await this.markRecoveryDebt(chatId, reason);
  }

  prepareEvict(chatId: string, reason: string): void {
    const ledger = this.ledgers.get(chatId);
    if (!ledger || ledger.entries.length === 0) return;
    void this.markRecoveryDebt(chatId, reason);
  }

  async drainForTerminate(chatId: string): Promise<void> {
    const ledger = this.ledgers.get(chatId);
    if (!ledger || ledger.entries.length === 0) return;

    let acceptedPrefixCount = 0;
    for (const tracked of ledger.entries) {
      if (tracked.phase === "tracked") break;
      acceptedPrefixCount++;
    }
    if (acceptedPrefixCount > 0) {
      const lastAccepted = ledger.entries[acceptedPrefixCount - 1];
      if (lastAccepted) await this.ackThrough(chatId, lastAccepted.entryId, "terminate");
    }

    const remaining = this.ledgers.get(chatId)?.entries ?? [];
    if (remaining.length > 0) await this.markRecoveryDebt(chatId, "terminate_unaccepted_remainder");
  }

  hasUnsettledWork(chatId: string): boolean {
    const ledger = this.ledgers.get(chatId);
    if (!ledger) return false;
    return ledger.entries.length > 0 || ledger.recoveryDebt !== "none" || ledger.admissionQueue !== null;
  }

  snapshot(chatId: string): WorkSnapshot {
    const ledger = this.ledgers.get(chatId);
    return {
      entries: (ledger?.entries ?? []).map((entry) => ({
        entryId: entry.entryId,
        messageId: entry.messageId,
        phase: entry.phase,
      })),
      recoveryDebt: ledger?.recoveryDebt ?? "none",
      admissionPending: ledger?.admissionQueue !== null,
    };
  }

  private async ackThrough(
    chatId: string,
    throughEntryId: number,
    reason: string,
    opts: { requireConsumedPrefix?: boolean } = {},
  ): Promise<void> {
    const ledger = this.ledgers.get(chatId);
    if (!ledger) return;
    const prev = ledger.ackQueue ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => this.ackThroughNow(chatId, throughEntryId, reason, opts));
    const queueMarker = next.then(
      () => {},
      () => {},
    );
    ledger.ackQueue = queueMarker;
    this.emitWorkChanged(chatId);
    try {
      await next;
    } finally {
      if (ledger.ackQueue === queueMarker) {
        ledger.ackQueue = null;
        this.cleanupLedger(chatId);
        this.emitWorkChanged(chatId);
      }
    }
  }

  private async ackThroughNow(
    chatId: string,
    throughEntryId: number,
    reason: string,
    opts: { requireConsumedPrefix?: boolean },
  ): Promise<void> {
    const ledger = this.ledgers.get(chatId);
    if (!ledger || ledger.entries.length === 0) return;
    if (ledger.recoveryDebt !== "none") {
      this.config.log.debug(
        { chatId, throughEntryId, reason },
        "ACK-through deferred because chat recovery is required",
      );
      return;
    }
    const index = ledger.entries.findIndex((tracked) => tracked.entryId === throughEntryId);
    if (index < 0) {
      this.config.log.warn({ chatId, throughEntryId, reason }, "attempt completion ignored for untracked inbox entry");
      return;
    }

    const ackPrefix = ledger.entries.slice(0, index + 1);
    if (
      opts.requireConsumedPrefix &&
      ackPrefix.some((tracked) => tracked.phase === "tracked" || tracked.phase === "accepted")
    ) {
      this.config.log.warn(
        {
          chatId,
          throughEntryId,
          reason,
          prefix: ackPrefix.map((entry) => ({ entryId: entry.entryId, phase: entry.phase })),
        },
        "ACK-through blocked because delivery prefix has unconsumed entries",
      );
      await this.markRecoveryDebt(chatId, `${reason}:unconsumed_prefix_gap`);
      return;
    }
    let changed = false;
    for (const tracked of ackPrefix) {
      if (tracked.phase !== "ackPending") {
        tracked.phase = "ackPending";
        changed = true;
      }
    }
    if (changed) this.emitWorkChanged(chatId);

    try {
      await this.config.ackEntry(throughEntryId);
    } catch (err) {
      this.config.log.warn({ chatId, entryId: throughEntryId, reason, err }, "ACK-through failed; retaining ledger");
      const current = this.ledgers.get(chatId);
      if (current) {
        for (const tracked of current.entries) {
          if (tracked.entryId <= throughEntryId && tracked.phase === "ackPending") {
            tracked.phase = "consumed";
          }
        }
      }
      this.emitWorkChanged(chatId);
      void this.markRecoveryDebt(chatId, `${reason}:ack_failed`);
      return;
    }

    const current = this.ledgers.get(chatId);
    if (!current) return;
    const committed = current.entries.filter((tracked) => tracked.entryId <= throughEntryId);
    current.entries = current.entries.filter((tracked) => tracked.entryId > throughEntryId);
    for (const tracked of committed) {
      this.deduplicator.drop(tracked.dedupKey);
    }
    if (current.entries.length === 0 && current.recoveryDebt === "required") {
      current.recoveryDebt = "none";
    }
    this.cleanupLedger(chatId);
    this.emitWorkChanged(chatId);
  }

  private async markRecoveryDebt(chatId: string, reason: string): Promise<void> {
    const ledger = this.ledger(chatId);
    if (ledger.recoveryDebt !== "required") {
      ledger.recoveryDebt = "required";
      this.emitWorkChanged(chatId);
    }
    this.config.log.warn(
      { chatId, reason, entryIds: ledger.entries.map((entry) => entry.entryId) },
      "chat has unsettled inbox work; waiting for recovery redelivery",
    );
    await this.requestRecovery(chatId, reason);
  }

  private clearEntriesForRecoverySuccess(chatId: string): void {
    const ledger = this.ledger(chatId);
    for (const tracked of ledger.entries) {
      this.deduplicator.drop(tracked.dedupKey);
    }
    ledger.entries = [];
  }

  private findEntry(chatId: string, entryId: number): TrackedDelivery | null {
    return this.ledgers.get(chatId)?.entries.find((entry) => entry.entryId === entryId) ?? null;
  }

  private messageEntryIds(chatId: string, messages: SessionMessage | readonly SessionMessage[]): Set<number> {
    const batch = Array.isArray(messages) ? messages : [messages];
    const entryIds = new Set<number>();
    for (const message of batch) {
      if (message.chatId === chatId && message.inboxEntryId !== undefined) entryIds.add(message.inboxEntryId);
    }
    return entryIds;
  }

  private lastMessageEntryId(chatId: string, messages: SessionMessage | readonly SessionMessage[]): number | undefined {
    const batch = Array.isArray(messages) ? messages : [messages];
    let throughEntryId: number | undefined;
    for (const message of batch) {
      if (message.chatId !== chatId) continue;
      if (message.inboxEntryId !== undefined) throughEntryId = message.inboxEntryId;
    }
    return throughEntryId;
  }

  private ledger(chatId: string): ChatInboxLedger {
    const existing = this.ledgers.get(chatId);
    if (existing) return existing;
    const ledger: ChatInboxLedger = {
      entries: [],
      recoveryDebt: "none",
      recoveryActivationReady: false,
      recoveryWindowOpen: false,
      admissionQueue: null,
      ackQueue: null,
    };
    this.ledgers.set(chatId, ledger);
    return ledger;
  }

  private cleanupLedger(chatId: string): void {
    const ledger = this.ledgers.get(chatId);
    if (!ledger) return;
    if (
      ledger.recoveryWindowOpen &&
      ledger.entries.length === 0 &&
      ledger.recoveryDebt === "none" &&
      ledger.admissionQueue === null &&
      ledger.ackQueue === null
    ) {
      ledger.recoveryWindowOpen = false;
    }
    if (
      ledger.entries.length === 0 &&
      ledger.recoveryDebt === "none" &&
      !ledger.recoveryActivationReady &&
      !ledger.recoveryWindowOpen &&
      ledger.admissionQueue === null &&
      ledger.ackQueue === null
    ) {
      this.ledgers.delete(chatId);
    }
  }

  private emitWorkChanged(chatId: string): void {
    this.config.onWorkChanged(chatId);
  }

  private dedupKey(chatId: string, messageId: string): string {
    return `${chatId}:${messageId}`;
  }
}
