import { Transform } from "node:stream";

export type StreamingUploadOptions = {
  /** The byte-limit stream sitting between the source and the consumer. */
  limiter: Transform;
  /** `pipeline(source, limiter)` — the producer half. */
  producer: Promise<unknown>;
  /** Starts the storage PUT consuming the limiter; must honor the signal. */
  startConsumer: (abortSignal: AbortSignal) => Promise<unknown>;
};

/**
 * Coordinate the two halves of a streaming upload so that EITHER failure
 * settles BOTH promptly and exactly one error surfaces:
 *
 * - producer fails (byte-count mismatch, client abort) → the consumer's
 *   in-flight PUT is aborted via the signal instead of waiting out an SDK
 *   timeout on a half-fed body;
 * - consumer fails (storage down) → the limiter is destroyed so the
 *   backpressured source→limiter pipeline can settle instead of stalling.
 *
 * Both halves are always awaited (a bare `Promise.all` would orphan the
 * second rejection as an unhandledRejection), and the producer's error wins
 * when both reject — it is the root cause; the consumer's is derived.
 */
export async function settleStreamingUpload(opts: StreamingUploadOptions): Promise<void> {
  const abort = new AbortController();
  const producer = opts.producer.catch((error: unknown) => {
    abort.abort();
    throw error;
  });
  const consumer = opts.startConsumer(abort.signal).catch((error: unknown) => {
    opts.limiter.destroy(error instanceof Error ? error : new Error(String(error)));
    throw error;
  });
  const [consumerResult, producerResult] = await Promise.allSettled([consumer, producer]);
  if (producerResult.status === "rejected") throw producerResult.reason;
  if (consumerResult.status === "rejected") throw consumerResult.reason;
}

export type ByteLimitStreamOptions = {
  /** Exact byte count the stream must carry (the declared Content-Length). */
  expectedBytes: number;
  /**
   * Error to destroy the stream with when the source exceeds
   * `expectedBytes`. A mismatch in either direction also fails the stream
   * at EOF with the same factory — the declared length is a contract, not
   * a hint (quota was reserved from it).
   */
  makeMismatchError: (seenBytes: number) => Error;
};

/**
 * Pass-through stream enforcing an exact byte count. Used between the
 * request stream and the object-storage PUT so no payload can sneak past
 * the size the quota reservation was made for:
 *
 * - more bytes than declared → destroys mid-flight (upload aborts);
 * - fewer bytes than declared (truncated body / client abort) → fails at
 *   EOF, before the storage layer could treat a short object as complete.
 *
 * Node's HTTP parser already cuts request bodies at Content-Length, so the
 * overshoot branch mostly guards non-HTTP callers and tests; the EOF check
 * is the load-bearing half.
 */
export function createByteLimitStream(opts: ByteLimitStreamOptions): Transform {
  let seenBytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seenBytes += chunk.byteLength;
      if (seenBytes > opts.expectedBytes) {
        callback(opts.makeMismatchError(seenBytes));
        return;
      }
      callback(null, chunk);
    },
    flush(callback) {
      if (seenBytes !== opts.expectedBytes) {
        callback(opts.makeMismatchError(seenBytes));
        return;
      }
      callback();
    },
  });
}
