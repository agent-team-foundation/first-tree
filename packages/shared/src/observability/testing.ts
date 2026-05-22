import { Writable } from "node:stream";
import { createLoggerOutputStream, type LogFormat } from "./logger-core.js";

/**
 * Logger utilities for tests. Exported from
 * `@first-tree/shared/observability` so both the
 * client and server test suites can silence or record logs without each
 * reinventing the pattern.
 *
 * Design: this module depends on `pino` indirectly — the returned objects
 * are plain pino Loggers the caller constructs from their own `pino` import.
 * We intentionally do NOT re-export `pino` from shared: shared must stay free
 * of the pino runtime dep so it can be consumed by client-only or
 * browser-bundling contexts without dragging the full logger stack in.
 *
 * The helpers here hand back the raw Writable sink — any caller already holds
 * a pino dependency (client/server), so pairing is a one-liner.
 */

/** A Writable that discards every write. Used to back a silent pino. */
export function silentDestination(): Writable {
  return new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
}

/** A Writable backed by an in-memory array of parsed JSON records. */
export function recordingDestination(): { dest: Writable; records: Array<Record<string, unknown>> } {
  const records: Array<Record<string, unknown>> = [];
  const dest = new Writable({
    write(chunk, _enc, cb) {
      try {
        records.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      } catch {
        // pino writes one JSON record per call — non-JSON lines are from some
        // other stream and are not useful in tests.
      }
      cb();
    },
  });
  return { dest, records };
}

/**
 * Produce a pino-compatible Writable that honours the format getter exactly
 * like the real logger sink. Useful when the test cares about pretty rendering
 * rather than the raw NDJSON payload.
 */
export function captureDestination(getFormat: () => LogFormat): { dest: Writable; read: () => string } {
  const chunks: string[] = [];
  const wrapper = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  // Route the same chunks through the formatter used by production loggers so
  // tests exercise the exact `[module] msg` layout they would see on stderr.
  const inner = createLoggerOutputStream({
    getFormat,
    getDestination: () => wrapper,
  });
  return { dest: inner, read: () => chunks.join("") };
}
