/**
 * SSE framing + stream helper for the Phase 3b daemon HTTP server.
 *
 * Byte-level parity with the Rust `send_sse` in
 * `http.rs:310-332` is a hard
 * requirement of Phase 3b. Any drift here leaks into the dashboard's
 * `EventSource` parsing.
 *
 * The Rust framing rule (ported verbatim by `encodeSseFrame` below):
 *
 *   frame = "event: <name>\n"
 *   for each line in data.split('\n') that is NOT the empty trailer
 *     caused by a trailing newline:
 *       frame += "data: <line>\n"
 *   if data ends with '\n':
 *       frame += "data: \n"
 *   frame += "\n"
 *
 * Rust's `str::lines()` has the subtle property that it does NOT yield an
 * empty string for a trailing `\n`. `"hello\n".lines()` iterates once
 * (`"hello"`) and stops. We match that behaviour here with
 * `splitIntoLines`.
 *
 * The trailing `data: \n` frame is the "suspicious" behaviour flagged in
 * the HTTP/SSE API contract (historical migration doc, now removed; see git history) §8. It does NOT fire for the
 * payloads Phase 3b emits (they are compact JSON without a trailing
 * newline) but we preserve it anyway so the TS server is a drop-in
 * replacement for the Rust one. The byte-exact test
 * (`tests/breeze-daemon-http.test.ts::encodes SSE frames identically to
 * Rust`) pins this.
 *
 * Keep-alive cadence: 15s of idle emits `: ping\n\n`, matching
 * `http.rs:282`.
 *
 * READ-ONLY MODULE: this file never touches `runtime/store.ts` writers.
 * The bus stub (`subscribeToInboxMtime`) is Phase 3b scaffolding —
 * Phase 3c replaces it with the real in-process `Bus`.
 */

import { type ServerResponse } from "node:http";
import { promises as fsp } from "node:fs";

export interface SseWritable {
  /** Write raw bytes. Returns false if the backpressure buffer is full. */
  write(chunk: string): boolean;
  /**
   * Flush (no-op on most Node streams; kept so tests can verify that we
   * don't rely on compression / output buffering).
   */
  flush?(): void;
}

/**
 * Port of the Rust `send_sse` framing. Returns the exact bytes the Rust
 * implementation would write to the wire for the same `(event, data)`.
 *
 * `data` is always encoded as-is, including any embedded `\n` — the
 * framing splits on them and emits one `data:` line per split.
 */
export function encodeSseFrame(event: string, data: string): string {
  let frame = `event: ${event}\n`;
  for (const line of splitIntoLines(data)) {
    frame += `data: ${line}\n`;
  }
  if (data.endsWith("\n")) {
    frame += "data: \n";
  }
  frame += "\n";
  return frame;
}

/**
 * Mirrors Rust's `str::lines()`:
 *   - split on `\n`
 *   - strip a trailing `\r` from each piece (so CRLF-delimited input
 *     yields the same shape as LF-delimited)
 *   - drop the empty trailing element caused by a terminal `\n`
 *
 * Exported for the fixture test.
 */
export function splitIntoLines(input: string): string[] {
  if (input.length === 0) return [];
  const parts = input.split("\n");
  // Rust semantics: a trailing '\n' produces no extra line.
  if (parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
  }
  // Strip the optional `\r` from each line (mirrors Rust behaviour).
  return parts.map((line) =>
    line.endsWith("\r") ? line.slice(0, -1) : line,
  );
}

/** Keep-alive comment-frame bytes. Must match `http.rs:282` exactly. */
export const SSE_KEEPALIVE = ": ping\n\n";

/** Hello frame the server emits right after the 200 headers. */
export const SSE_READY_FRAME = encodeSseFrame("ready", '"subscribed"');

/**
 * Minimal event shape the stub bus yields. The Phase 3c broker/bus will
 * satisfy the same contract with richer wiring.
 */
export type SseEvent =
  | {
      kind: "inbox";
      last_poll: string;
      total: number;
      new_count: number;
    }
  | { kind: "activity"; line: string };

export interface SseBus {
  /**
   * Subscribe to event notifications. The returned function unsubscribes.
   * The bus will never call the listener synchronously on subscribe.
   */
  subscribe(listener: (event: SseEvent) => void): () => void;
}

/**
 * Serialize an SseEvent into the exact bytes Rust's `emit_event` would.
 * The `inbox` payload must use deterministic key order
 * (`last_poll, total, new_count`) and no whitespace to match the Rust
 * `Json::Object` encoder (`http.rs:298-303` + `json.rs`).
 */
export function encodeSseEvent(event: SseEvent): string {
  if (event.kind === "inbox") {
    const payload = `{"last_poll":${JSON.stringify(event.last_poll)},"total":${event.total},"new_count":${event.new_count}}`;
    return encodeSseFrame("inbox", payload);
  }
  return encodeSseFrame("activity", event.line);
}

/**
 * Phase 3b stub bus: poll `inboxPath` mtime at 1s intervals and, on
 * change, emit a synthetic `{kind: "inbox"}` event with `total` /
 * `new_count` read from the file. Phase 3c replaces this with the real
 * in-process publisher the poller drives.
 *
 * The stub is deliberately dumb: if the file is missing or malformed
 * we silently skip the tick. We read via `fs.promises` to avoid blocking
 * the event loop on a slow disk.
 */
export function createInboxMtimeBus(options: {
  inboxPath: string;
  intervalMs?: number;
  signal?: AbortSignal;
}): SseBus {
  const intervalMs = options.intervalMs ?? 1000;
  const listeners = new Set<(event: SseEvent) => void>();
  let lastMtimeMs = -1;
  let stopped = false;

  const tick = async (): Promise<void> => {
    try {
      const stat = await fsp.stat(options.inboxPath);
      const mtime = stat.mtimeMs;
      if (mtime === lastMtimeMs) return;
      const prev = lastMtimeMs;
      lastMtimeMs = mtime;
      // First observation on startup: do not emit. The dashboard
      // fetches /inbox directly on connect; we only need to notify on
      // subsequent changes.
      if (prev === -1) return;
      const raw = await fsp.readFile(options.inboxPath, "utf-8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== "object") return;
      const p = parsed as {
        last_poll?: unknown;
        notifications?: unknown;
      };
      const notifications = Array.isArray(p.notifications)
        ? p.notifications
        : [];
      const last_poll = typeof p.last_poll === "string" ? p.last_poll : "";
      let new_count = 0;
      for (const entry of notifications) {
        if (
          entry &&
          typeof entry === "object" &&
          (entry as { breeze_status?: unknown }).breeze_status === "new"
        ) {
          new_count += 1;
        }
      }
      const event: SseEvent = {
        kind: "inbox",
        last_poll,
        total: notifications.length,
        new_count,
      };
      for (const listener of listeners) listener(event);
    } catch {
      // File missing or unreadable — skip this tick.
    }
  };

  const interval = setInterval(() => {
    if (stopped) return;
    void tick();
  }, intervalMs);
  // Don't let the poll keep the process alive past daemon shutdown.
  if (typeof interval.unref === "function") interval.unref();

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    listeners.clear();
  };
  if (options.signal) {
    if (options.signal.aborted) stop();
    else options.signal.addEventListener("abort", stop, { once: true });
  }

  return {
    subscribe(listener) {
      if (stopped) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * Per-connection SSE driver. Writes the 200 headers (caller is
 * responsible for the status line / headers via `writeHead`), then the
 * ready frame, then every event until `signal` aborts or the client
 * disconnects.
 */
export interface RunSseStreamOptions {
  response: ServerResponse;
  bus: SseBus;
  signal: AbortSignal;
  /** Keep-alive cadence in ms. Default 15s to match Rust. */
  keepAliveMs?: number;
  /** Timer factory override for tests. */
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}

export function runSseStream(options: RunSseStreamOptions): Promise<void> {
  const keepAliveMs = options.keepAliveMs ?? 15_000;
  const setIntervalFn = options.setInterval ?? setInterval;
  const clearIntervalFn = options.clearInterval ?? clearInterval;

  return new Promise<void>((resolve) => {
    const { response, bus, signal } = options;
    let settled = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      try {
        response.end();
      } catch {
        // ignore — client may have already disconnected.
      }
      unsubscribe();
      clearIntervalFn(keepAlive);
      signal.removeEventListener("abort", onAbort);
      response.off("close", onClose);
      response.off("error", onError);
      resolve();
    };

    const onAbort = (): void => finish();
    const onClose = (): void => finish();
    const onError = (): void => finish();

    // Ready frame first so the client's `addEventListener("ready")`
    // fires before any inbox/activity traffic.
    try {
      response.write(SSE_READY_FRAME);
    } catch {
      finish();
      return;
    }

    const unsubscribe = bus.subscribe((event) => {
      if (settled) return;
      try {
        const ok = response.write(encodeSseEvent(event));
        // If backpressure kicks in we still return — the OS buffer will
        // handle it, and matching Rust's blocking `write_all` semantics
        // doesn't justify stalling the bus here.
        if (!ok) {
          // no-op; let Node drain naturally
        }
      } catch {
        finish();
      }
    });

    const keepAlive = setIntervalFn(() => {
      if (settled) return;
      try {
        response.write(SSE_KEEPALIVE);
      } catch {
        finish();
      }
    }, keepAliveMs);
    // Don't let the keep-alive timer keep the process alive after the
    // controller aborts.
    if (typeof (keepAlive as { unref?: () => void }).unref === "function") {
      (keepAlive as { unref: () => void }).unref();
    }

    if (signal.aborted) {
      finish();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    response.on("close", onClose);
    response.on("error", onError);
  });
}
