import { ATTACHMENT_ERROR_CODES } from "@first-tree/shared";
import { TooManyRequestsError } from "../errors.js";

export type UploadGate = {
  /**
   * Claim an upload slot for `uploaderId`. Throws `TooManyRequestsError`
   * (429, `ATTACHMENT_CONCURRENCY_EXCEEDED`) when the uploader already
   * holds `maxConcurrent` streams. The returned function releases the slot
   * and MUST run exactly once (call it from a `finally`).
   */
  acquire(uploaderId: string): () => void;
};

/**
 * Per-uploader concurrency gate for streaming uploads. Bounds how many
 * parallel upload streams one uploader identity may hold on THIS server
 * instance — the uploader key is `humanAgentId`, so all of one person's
 * agents share the budget, and multi-replica deployments multiply the
 * bound by the replica count (same in-process scoping as
 * @fastify/rate-limit's default store; PostgreSQL stays the only shared
 * backend). The global request rate limiter still applies on top.
 */
export function createUploadGate(maxConcurrent: number): UploadGate {
  const inFlight = new Map<string, number>();
  return {
    acquire(uploaderId) {
      const current = inFlight.get(uploaderId) ?? 0;
      if (current >= maxConcurrent) {
        throw new TooManyRequestsError(`Too many concurrent attachment uploads (limit ${maxConcurrent} per uploader)`, {
          code: ATTACHMENT_ERROR_CODES.concurrencyExceeded,
        });
      }
      inFlight.set(uploaderId, current + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const value = inFlight.get(uploaderId) ?? 0;
        if (value <= 1) {
          inFlight.delete(uploaderId);
        } else {
          inFlight.set(uploaderId, value - 1);
        }
      };
    },
  };
}
