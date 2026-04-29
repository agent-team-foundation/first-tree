/**
 * Phase 3c: in-process event bus for the TypeScript auto daemon.
 *
 * Port of `bus.rs`.
 *
 * SINGLE-WRITER RULE (spec doc 2 §1.3):
 * -------------------------------------
 * This module is **read-only** with respect to `~/.first-tree/auto/inbox.json`.
 * Only the poller (`daemon/poller.ts`) writes the inbox. The bus
 * multicasts events produced by the poller/broker; subscribers (http SSE
 * stream, the broker's own completion handler, future observers) only
 * consume events. Never call a store writer from a subscriber.
 *
 * Design (matches Rust `Bus`):
 * ----------------------------
 *   - Publishers call `bus.publish(event)`. Delivery is synchronous:
 *     `publish` iterates the subscriber list and invokes each listener
 *     on the calling stack (ordering guaranteed per-subscriber).
 *   - Subscribers call `bus.subscribe(listener)` and get back an
 *     unsubscribe function. The listener receives every event published
 *     after subscription; there is no replay of historical events.
 *   - Listeners that throw do NOT abort publishing — the thrown error is
 *     swallowed and the next listener is still called, matching Rust's
 *     `sender.send(event.clone()).is_ok()` retain-on-success semantics.
 *     (In Rust the analogue is that a dropped receiver short-circuits
 *     its own delivery; a thrown exception on our side is the nearest
 *     equivalent.)
 *
 * Backpressure:
 *   - Rust uses an unbounded `mpsc::channel`, so a slow subscriber can
 *     accumulate arbitrarily many queued events. We match that: delivery
 *     is synchronous and unbounded per listener, because our listeners
 *     (SSE stream writer, broker completion handler) are non-blocking
 *     against the bus. If a future subscriber needs to buffer, it can
 *     keep its own queue.
 *   - There is no drop policy. A listener that returns without throwing
 *     is assumed to have consumed the event; a listener that throws is
 *     logged (via the optional `onError` hook) but stays subscribed.
 *
 * Shutdown:
 *   - `close()` detaches every subscriber and marks the bus as stopped.
 *   - After `close()`, further `publish` calls are no-ops (events are
 *     dropped silently). Late `subscribe` calls return an already-detached
 *     unsubscribe function. This matches Rust's "drop the bus; senders
 *     time out" behaviour.
 */

/**
 * Event payloads broadcast by the Phase 3c bus. Discriminated on `kind`.
 *
 * The `inbox` event mirrors Rust `Event::InboxUpdated` (bus.rs:12-19),
 * fired by the poller after each successful `pollOnce`. The `activity`
 * event mirrors `Event::Activity` and is fired both by the poller (for
 * `new`/`transition`) and by the broker (for `dispatched`/`completed`).
 *
 * Broker-specific events are additive compared to the Rust bus, which
 * only carried `InboxUpdated` and `Activity`. We keep the wire names
 * stable so the SSE layer doesn't need to discriminate new kinds: the
 * broker events are delivered as `activity` lines (see `encodeSseEvent`
 * in `sse.ts`).
 */
export type BusEvent =
  | {
      kind: "inbox";
      last_poll: string;
      total: number;
      new_count: number;
    }
  | { kind: "activity"; line: string }
  | {
      kind: "task";
      /** `dispatched` | `completed` | `failed` | `timed_out`. */
      phase: "dispatched" | "completed" | "failed" | "timed_out";
      task_id: string;
      thread_key: string;
      /** Final status (for `completed`/`failed`/`timed_out`). */
      status?: string;
      /** Error or result summary. */
      summary?: string;
    };

export type BusListener = (event: BusEvent) => void;

export interface BusOptions {
  /**
   * Called when a subscriber throws during delivery. Defaults to a
   * silent swallow to preserve fan-out semantics. The daemon wires a
   * logger in production so operators see broker misbehaviour.
   */
  onListenerError?: (err: unknown) => void;
}

export interface Bus {
  /** Publish an event to every live subscriber. */
  publish(event: BusEvent): void;
  /** Register a listener. Returns an unsubscribe function (idempotent). */
  subscribe(listener: BusListener): () => void;
  /** Detach every subscriber and stop accepting further publishes. */
  close(): void;
  /** Live subscriber count. Useful for tests and shutdown drains. */
  subscriberCount(): number;
  /** True after `close()` has been called. */
  isClosed(): boolean;
}

/**
 * Build a fresh in-process bus. Each daemon run creates exactly one
 * instance; tests build an isolated one per case.
 */
export function createBus(options: BusOptions = {}): Bus {
  const listeners = new Set<BusListener>();
  let closed = false;
  const onError = options.onListenerError ?? ((): void => {});

  return {
    publish(event) {
      if (closed) return;
      // Snapshot before iteration so an unsubscribe mid-publish does
      // not skip a pending listener (matches Rust's `retain`).
      const snapshot = Array.from(listeners);
      for (const listener of snapshot) {
        try {
          listener(event);
        } catch (err) {
          try {
            onError(err);
          } catch {
            /* swallow — onError must not break fan-out. */
          }
        }
      }
    },
    subscribe(listener) {
      if (closed) return () => {};
      listeners.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        listeners.delete(listener);
      };
    },
    close() {
      if (closed) return;
      closed = true;
      listeners.clear();
    },
    subscriberCount() {
      return listeners.size;
    },
    isClosed() {
      return closed;
    },
  };
}

/**
 * Adapter that exposes a `Bus` through the narrower `SseBus` interface
 * expected by `daemon/sse.ts::runSseStream`. It forwards only the events
 * that the SSE layer renders (`inbox`, `activity`, and `task` mapped to
 * `activity` lines) and drops the rest.
 *
 * Keeping the adapter here (rather than inside `sse.ts`) preserves the
 * Phase 3b SSE module's read-only posture and means we don't need to
 * widen `SseEvent` to know about broker internals.
 */
export function toSseBus(bus: Bus): {
  subscribe(listener: (ev: import("./sse.js").SseEvent) => void): () => void;
} {
  return {
    subscribe(listener) {
      return bus.subscribe((event) => {
        if (event.kind === "inbox") {
          listener({
            kind: "inbox",
            last_poll: event.last_poll,
            total: event.total,
            new_count: event.new_count,
          });
          return;
        }
        if (event.kind === "activity") {
          listener({ kind: "activity", line: event.line });
          return;
        }
        if (event.kind === "task") {
          // Render broker-internal task events as activity lines so
          // the dashboard shows them without schema churn. Compact JSON
          // keeps parity with `activity.log` jsonl entries.
          const payload: Record<string, unknown> = {
            event: `task_${event.phase}`,
            task_id: event.task_id,
            thread_key: event.thread_key,
          };
          if (event.status !== undefined) payload.status = event.status;
          if (event.summary !== undefined) payload.summary = event.summary;
          listener({
            kind: "activity",
            line: JSON.stringify(payload),
          });
        }
      });
    },
  };
}
