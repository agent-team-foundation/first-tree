import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createInboxMtimeBus,
  encodeSseEvent,
  runSseStream,
  SSE_KEEPALIVE,
  SSE_READY_FRAME,
  type SseEvent,
} from "../../src/github-scan/engine/daemon/sse.js";

class FakeResponse extends EventEmitter {
  chunks: string[] = [];
  ended = false;
  throwOnWrite = false;
  writeReturns = true;

  write(chunk: string): boolean {
    if (this.throwOnWrite) throw new Error("write failed");
    this.chunks.push(chunk);
    return this.writeReturns;
  }

  end(): void {
    this.ended = true;
  }
}

const tempRoots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "github-scan-sse-"));
  tempRoots.push(root);
  return root;
}

function writeInbox(
  path: string,
  notifications: Array<{ github_scan_status?: string }>,
  lastPoll = "2026-05-28T00:00:00Z",
) {
  writeFileSync(path, JSON.stringify({ last_poll: lastPoll, notifications }), "utf-8");
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("createInboxMtimeBus", () => {
  it("emits inbox counts only after the first observed mtime and skips malformed reads", async () => {
    const root = tempRoot();
    const inboxPath = join(root, "inbox.json");
    const controller = new AbortController();
    const bus = createInboxMtimeBus({ inboxPath, intervalMs: 10, signal: controller.signal });
    const events: SseEvent[] = [];
    const unsubscribe = bus.subscribe((event) => events.push(event));

    await wait(20);
    expect(events).toEqual([]);

    writeInbox(inboxPath, [{ github_scan_status: "new" }, { github_scan_status: "done" }]);
    await wait(20);
    expect(events).toEqual([]);

    writeFileSync(inboxPath, "{not json", "utf-8");
    await wait(20);
    expect(events).toEqual([]);

    writeInbox(inboxPath, [{ github_scan_status: "new" }, { github_scan_status: "new" }, {}], "later");
    await wait(20);
    expect(events).toContainEqual({ kind: "inbox", last_poll: "later", total: 3, new_count: 2 });

    const eventCountAfterValidWrite = events.length;
    unsubscribe();
    writeInbox(inboxPath, [{ github_scan_status: "new" }], "after-unsubscribe");
    await wait(20);
    expect(events).toHaveLength(eventCountAfterValidWrite);

    controller.abort();
    expect(bus.subscribe(() => undefined)).toEqual(expect.any(Function));
  });
});

describe("runSseStream", () => {
  it("writes ready, event, keepalive, and closes on abort", async () => {
    let listener: ((event: SseEvent) => void) | null = null;
    let keepAlive: (() => void) | null = null;
    const response = new FakeResponse();
    const controller = new AbortController();
    const stream = runSseStream({
      response: response as never,
      signal: controller.signal,
      bus: {
        subscribe(fn) {
          listener = fn;
          return () => {
            listener = null;
          };
        },
      },
      setInterval: ((fn: () => void) => {
        keepAlive = fn;
        return { unref: () => undefined };
      }) as never,
      clearInterval: (() => undefined) as never,
    });

    expect(response.chunks).toEqual([SSE_READY_FRAME]);
    listener?.({ kind: "activity", line: "task started" });
    listener?.({ kind: "inbox", last_poll: "now", total: 2, new_count: 1 });
    keepAlive?.();
    expect(response.chunks).toEqual([
      SSE_READY_FRAME,
      encodeSseEvent({ kind: "activity", line: "task started" }),
      encodeSseEvent({ kind: "inbox", last_poll: "now", total: 2, new_count: 1 }),
      SSE_KEEPALIVE,
    ]);

    controller.abort();
    await expect(stream).resolves.toBeUndefined();
    expect(response.ended).toBe(true);
    expect(listener).toBeNull();
  });

  it("finishes when event or keepalive writes fail", async () => {
    let listener: ((event: SseEvent) => void) | null = null;
    const eventFailure = new FakeResponse();
    const eventStream = runSseStream({
      response: eventFailure as never,
      signal: new AbortController().signal,
      bus: {
        subscribe(fn) {
          listener = fn;
          return () => undefined;
        },
      },
      setInterval: (() => ({ unref: () => undefined })) as never,
      clearInterval: (() => undefined) as never,
    });
    eventFailure.throwOnWrite = true;
    listener?.({ kind: "activity", line: "boom" });
    await expect(eventStream).resolves.toBeUndefined();
    expect(eventFailure.ended).toBe(true);

    let keepAlive: (() => void) | null = null;
    const keepAliveFailure = new FakeResponse();
    const keepAliveStream = runSseStream({
      response: keepAliveFailure as never,
      signal: new AbortController().signal,
      bus: { subscribe: () => () => undefined },
      setInterval: ((fn: () => void) => {
        keepAlive = fn;
        return { unref: () => undefined };
      }) as never,
      clearInterval: (() => undefined) as never,
    });
    keepAliveFailure.throwOnWrite = true;
    keepAlive?.();
    await expect(keepAliveStream).resolves.toBeUndefined();
    expect(keepAliveFailure.ended).toBe(true);
  });
});
