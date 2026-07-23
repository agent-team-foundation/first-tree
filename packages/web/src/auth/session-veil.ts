declare const sessionVeilTokenType: unique symbol;

export const SESSION_VEIL_REASON_MAX_LENGTH = 96;

export type SessionVeilSnapshot = Readonly<{
  revision: number;
  veiled: boolean;
  reason: string | null;
}>;

export type SessionVeilToken = Readonly<{
  [sessionVeilTokenType]: never;
}>;

export type SessionVeilSubscriber = (snapshot: SessionVeilSnapshot) => void;

type TokenState = {
  controller: SessionVeilController;
  reason: string;
  live: boolean;
};

type SubscriberState = {
  subscriber: SessionVeilSubscriber;
  lastRevision: number;
  live: boolean;
};

const tokenStates = new WeakMap<object, TokenState>();

function boundedReason(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const reason = value.trim();
  if (reason.length === 0) return fallback;
  return reason.slice(0, SESSION_VEIL_REASON_MAX_LENGTH);
}

function snapshot(revision: number, veiled: boolean, reason: string | null): SessionVeilSnapshot {
  return Object.freeze({ revision, veiled, reason });
}

function reportSubscriberError(error: unknown): void {
  try {
    const report = globalThis.reportError;
    if (typeof report === "function") report(error);
  } catch {
    // Reporting failures must not interrupt the veil's authority transition.
  }
}

/**
 * Owns the synchronous authenticated-shell veil. Async reconciliation must
 * call begin() before its first await and may reveal only with the returned
 * latest-live capability.
 */
export class SessionVeilController {
  #snapshot: SessionVeilSnapshot;
  #subscribers = new Set<SubscriberState>();
  #notificationQueue: SessionVeilSnapshot[] = [];
  #notifying = false;
  #latestToken: SessionVeilToken | null = null;

  constructor(initialReason = "boot") {
    this.#snapshot = snapshot(0, true, boundedReason(initialReason, "boot"));
  }

  getSnapshot(): SessionVeilSnapshot {
    return this.#snapshot;
  }

  subscribe(subscriber: SessionVeilSubscriber): () => void {
    if (typeof subscriber !== "function") throw new TypeError("Session veil subscriber must be a function");
    const state: SubscriberState = { subscriber, lastRevision: this.#snapshot.revision, live: true };
    this.#subscribers.add(state);
    try {
      subscriber(this.#snapshot);
    } catch (error) {
      this.#subscribers.delete(state);
      throw error;
    }

    return () => {
      if (!state.live) return;
      state.live = false;
      this.#subscribers.delete(state);
    };
  }

  begin(reason: string): SessionVeilToken {
    this.#invalidateLatest();
    const bounded = boundedReason(reason, "reconciliation");
    const token = Object.freeze(Object.create(null)) as SessionVeilToken;
    tokenStates.set(token, { controller: this, reason: bounded, live: true });
    this.#latestToken = token;
    this.#publish(true, bounded);
    return token;
  }

  reveal(token: SessionVeilToken): boolean {
    if (!this.#settleLatest(token)) return false;
    this.#publish(false, null);
    return true;
  }

  keepVeiled(token: SessionVeilToken, reason?: string): boolean {
    const state = this.#latestState(token);
    if (!state) return false;
    const bounded = boundedReason(reason, state.reason);
    this.#settle(state, token);
    this.#publish(true, bounded);
    return true;
  }

  fail(token: SessionVeilToken, reason = "reconciliation_failed"): boolean {
    const state = this.#latestState(token);
    if (!state) return false;
    const bounded = boundedReason(reason, "reconciliation_failed");
    this.#settle(state, token);
    this.#publish(true, bounded);
    return true;
  }

  #latestState(token: SessionVeilToken): TokenState | null {
    if ((typeof token !== "object" && typeof token !== "function") || token === null) return null;
    const state = tokenStates.get(token);
    if (!state || !state.live || state.controller !== this || this.#latestToken !== token) return null;
    return state;
  }

  #settleLatest(token: SessionVeilToken): boolean {
    const state = this.#latestState(token);
    if (!state) return false;
    this.#settle(state, token);
    return true;
  }

  #settle(state: TokenState, token: SessionVeilToken): void {
    state.live = false;
    tokenStates.delete(token);
    if (this.#latestToken === token) this.#latestToken = null;
  }

  #invalidateLatest(): void {
    const token = this.#latestToken;
    if (!token) return;
    const state = tokenStates.get(token);
    if (state) state.live = false;
    tokenStates.delete(token);
    this.#latestToken = null;
  }

  #publish(veiled: boolean, reason: string | null): void {
    const next = snapshot(this.#snapshot.revision + 1, veiled, reason);
    this.#snapshot = next;
    this.#notificationQueue.push(next);
    if (this.#notifying) return;

    this.#notifying = true;
    try {
      while (this.#notificationQueue.length > 0) {
        const current = this.#notificationQueue.shift();
        if (!current || current.revision !== this.#snapshot.revision) continue;
        for (const state of [...this.#subscribers]) {
          if (current.revision !== this.#snapshot.revision) break;
          if (!state.live || state.lastRevision >= current.revision) continue;
          state.lastRevision = current.revision;
          try {
            state.subscriber(current);
          } catch (error) {
            reportSubscriberError(error);
          }
        }
      }
    } finally {
      this.#notifying = false;
    }
  }
}
