import { recordingDestination, silentDestination } from "@first-tree/shared/observability";
import pino from "pino";

/** Silent logger for tests that don't care about log output. */
export function silentLogger(): pino.Logger {
  return pino({ level: "silent" }, silentDestination());
}

/**
 * Logger that captures every emitted record as a parsed JSON object. Useful
 * when a test needs to assert on log content without scraping stderr.
 */
export function recordingLogger(): { logger: pino.Logger; records: Array<Record<string, unknown>> } {
  const { dest, records } = recordingDestination();
  const logger = pino({ level: "trace" }, dest);
  return { logger, records };
}
