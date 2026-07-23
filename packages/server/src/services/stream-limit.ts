import { Transform } from "node:stream";

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
