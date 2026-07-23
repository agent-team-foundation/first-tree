import { PassThrough, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createByteLimitStream, settleStreamingUpload } from "../services/stream-limit.js";

function limiterFor(expectedBytes: number) {
  return createByteLimitStream({
    expectedBytes,
    makeMismatchError: (seen) => new Error(`mismatch: declared ${expectedBytes}, saw ${seen}`),
  });
}

async function drain(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe("createByteLimitStream", () => {
  it("passes an exact-length body through unchanged", async () => {
    const limiter = limiterFor(6);
    const [collected] = await Promise.all([drain(limiter), pipeline(Readable.from([Buffer.from("sixby!")]), limiter)]);
    expect(collected.toString()).toBe("sixby!");
  });

  it("fails mid-stream when the body exceeds the declared length", async () => {
    const limiter = limiterFor(3);
    await expect(
      Promise.all([
        drain(limiter).catch(() => Buffer.alloc(0)),
        pipeline(Readable.from([Buffer.from("sixby!")]), limiter),
      ]),
    ).rejects.toThrow(/mismatch: declared 3, saw 6/);
  });

  it("fails at EOF when the body undershoots the declared length", async () => {
    const limiter = limiterFor(10);
    await expect(
      Promise.all([
        drain(limiter).catch(() => Buffer.alloc(0)),
        pipeline(Readable.from([Buffer.from("shrt")]), limiter),
      ]),
    ).rejects.toThrow(/mismatch: declared 10, saw 4/);
  });
});

describe("settleStreamingUpload — cross-cancel coordination", () => {
  // The whole point of the coordinator (and of commit "cross-cancel
  // streaming upload halves") is that NO failure mode may orphan a
  // rejection. Collect any unhandled rejections that surface between test
  // start and a post-test settle window, and assert zero.
  const orphans: unknown[] = [];
  const collect = (reason: unknown) => {
    orphans.push(reason);
  };

  beforeEach(() => {
    orphans.length = 0;
    process.on("unhandledRejection", collect);
  });

  afterEach(async () => {
    // Give any stray rejection two macrotask turns to surface.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    process.off("unhandledRejection", collect);
    expect(orphans).toEqual([]);
  });

  it("producer failure aborts the consumer and surfaces the producer error", async () => {
    const limiter = limiterFor(3);
    let observedSignal: AbortSignal | undefined;
    const consumerSettled: string[] = [];

    await expect(
      settleStreamingUpload({
        limiter,
        producer: pipeline(Readable.from([Buffer.from("sixby!")]), limiter),
        startConsumer: (abortSignal) => {
          observedSignal = abortSignal;
          return new Promise((_resolve, reject) => {
            abortSignal.addEventListener("abort", () => {
              consumerSettled.push("aborted");
              reject(new Error("consumer aborted"));
            });
          });
        },
      }),
    ).rejects.toThrow(/mismatch: declared 3, saw 6/);

    expect(observedSignal?.aborted).toBe(true);
    expect(consumerSettled).toEqual(["aborted"]);
  });

  it("consumer failure destroys the limiter so the backpressured producer settles", async () => {
    const limiter = limiterFor(1024);
    // A source that never ends: without the cross-cancel, pipeline() would
    // wait forever once the consumer stops reading.
    const source = new PassThrough();
    source.write(Buffer.from("partial"));

    await expect(
      settleStreamingUpload({
        limiter,
        producer: pipeline(source, limiter),
        startConsumer: async () => {
          throw new Error("storage down");
        },
      }),
    ).rejects.toThrow(/storage down/);

    expect(limiter.destroyed).toBe(true);
    source.destroy();
  });

  it("prefers the producer error when both halves reject", async () => {
    const limiter = limiterFor(3);
    await expect(
      settleStreamingUpload({
        limiter,
        producer: pipeline(Readable.from([Buffer.from("sixby!")]), limiter),
        // The consumer fails with its OWN error once the abort reaches it —
        // a genuine double rejection; the mismatch (root cause) must win.
        startConsumer: (abortSignal) =>
          new Promise((_resolve, reject) => {
            abortSignal.addEventListener("abort", () => reject(new Error("storage down")));
          }),
      }),
    ).rejects.toThrow(/mismatch: declared 3/);
  });

  it("resolves cleanly when both halves succeed", async () => {
    const limiter = limiterFor(6);
    await expect(
      settleStreamingUpload({
        limiter,
        producer: pipeline(Readable.from([Buffer.from("sixby!")]), limiter),
        startConsumer: async (abortSignal) => {
          const collected = await drain(limiter);
          expect(collected.toString()).toBe("sixby!");
          expect(abortSignal.aborted).toBe(false);
        },
      }),
    ).resolves.toBeUndefined();
  });
});
