/**
 * Contract tests for the Phase 3b TypeScript port of the breeze daemon
 * HTTP + SSE server.
 *
 * Spec: `docs/migration/01-http-api-contract.md`. Source of truth:
 * `first-tree-breeze/breeze-runner/src/http.rs`.
 *
 * Per route, the test asserts status code, key headers, and body shape
 * against the contract. The SSE test additionally pins byte-exact
 * framing, including the Rust-quirk trailing `data: \n` path the
 * contract doc §8 flagged for TS verification.
 */

import { request as httpRequest } from "node:http";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ACTIVITY_TAIL_LIMIT,
  parseRoute,
  startHttpServer,
  tailAsJsonArray,
} from "../src/products/breeze/engine/daemon/http.js";
import {
  encodeSseFrame,
  encodeSseEvent,
  splitIntoLines,
  SSE_KEEPALIVE,
  SSE_READY_FRAME,
  type SseBus,
  type SseEvent,
} from "../src/products/breeze/engine/daemon/sse.js";

/** Minimal controllable bus for SSE tests. */
function makeManualBus(): {
  bus: SseBus;
  emit: (ev: SseEvent) => void;
  subscribers: number;
} {
  const listeners = new Set<(ev: SseEvent) => void>();
  const bus: SseBus = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    bus,
    emit: (ev) => {
      for (const l of listeners) l(ev);
    },
    get subscribers() {
      return listeners.size;
    },
  };
}

interface RawResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: Buffer;
}

function fetchRaw(
  port: number,
  path: string,
  method = "GET",
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === "string") headers[k.toLowerCase()] = v;
            else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(",");
          }
          resolve({
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? "",
            headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

interface Ctx {
  dir: string;
  inbox: string;
  activity: string;
}

function makeCtx(): Ctx {
  const dir = mkdtempSync(join(tmpdir(), "breeze-http-"));
  return {
    dir,
    inbox: join(dir, "inbox.json"),
    activity: join(dir, "activity.log"),
  };
}

const SILENT_LOGGER = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/* ------------------------------------------------------------------ */
/* Unit tests that don't need a bound server                           */
/* ------------------------------------------------------------------ */

describe("parseRoute", () => {
  it("matches the Rust route table from http.rs::parse_route", () => {
    expect(parseRoute("GET", "/")).toBe("dashboard");
    expect(parseRoute("GET", "/dashboard")).toBe("dashboard");
    expect(parseRoute("GET", "/index.html")).toBe("dashboard");
    expect(parseRoute("GET", "/healthz")).toBe("healthz");
    expect(parseRoute("GET", "/inbox")).toBe("inbox");
    expect(parseRoute("GET", "/activity")).toBe("activity");
    expect(parseRoute("GET", "/events")).toBe("events");
    // query strings are stripped
    expect(parseRoute("GET", "/inbox?all=1")).toBe("inbox");
    // non-GET → not-found
    expect(parseRoute("POST", "/inbox")).toBe("not-found");
    expect(parseRoute("DELETE", "/")).toBe("not-found");
    // unknown path
    expect(parseRoute("GET", "/nope")).toBe("not-found");
    expect(parseRoute("GET", undefined)).toBe("not-found");
  });
});

describe("tailAsJsonArray", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => rmSync(ctx.dir, { recursive: true, force: true }));

  it("returns [] when the file is missing", () => {
    expect(tailAsJsonArray(ctx.activity, 200)).toBe("[]");
  });

  it("keeps only the last N non-empty lines, comma-joined, without re-parsing", () => {
    writeFileSync(
      ctx.activity,
      '{"n":1}\n{"n":2}\n\n{"n":3}\n',
      "utf-8",
    );
    expect(tailAsJsonArray(ctx.activity, 2)).toBe('[{"n":2},{"n":3}]');
    expect(tailAsJsonArray(ctx.activity, 10)).toBe(
      '[{"n":1},{"n":2},{"n":3}]',
    );
  });

  it("passes malformed JSON lines through unchanged (matches Rust)", () => {
    writeFileSync(ctx.activity, "{bogus}\n{also-bad}\n", "utf-8");
    expect(tailAsJsonArray(ctx.activity, 10)).toBe("[{bogus},{also-bad}]");
  });

  it("exposes the hardcoded 200-line limit constant", () => {
    expect(ACTIVITY_TAIL_LIMIT).toBe(200);
  });
});

describe("SSE framing — byte-level parity with Rust send_sse", () => {
  it("splitIntoLines mirrors Rust str::lines()", () => {
    expect(splitIntoLines("")).toEqual([]);
    expect(splitIntoLines("hello")).toEqual(["hello"]);
    expect(splitIntoLines("hello\n")).toEqual(["hello"]);
    expect(splitIntoLines("a\nb\nc")).toEqual(["a", "b", "c"]);
    expect(splitIntoLines("a\nb\nc\n")).toEqual(["a", "b", "c"]);
    expect(splitIntoLines("a\r\nb\r\n")).toEqual(["a", "b"]);
  });

  it("single-line data (no trailing newline) emits a single data: frame", () => {
    // This is the actual shape the `inbox` event takes — compact JSON
    // object with no trailing '\n'. Must NOT produce the spurious
    // `data: \n` frame.
    const payload = '{"last_poll":"2026-04-16T20:15:30Z","total":422,"new_count":3}';
    const frame = encodeSseFrame("inbox", payload);
    expect(frame).toBe(`event: inbox\ndata: ${payload}\n\n`);
  });

  it("multi-line data emits one data: line per split (Rust parity)", () => {
    const frame = encodeSseFrame("activity", "a\nb\nc");
    expect(frame).toBe("event: activity\ndata: a\ndata: b\ndata: c\n\n");
  });

  it("preserves Rust's trailing `data: \\n` quirk when data ends with a newline", () => {
    // Contract doc §8 flagged this behaviour for verification. Rust
    // appends an empty `data: \n` before the frame-terminating blank
    // line whenever `data.ends_with('\n')`. We preserve it byte-exact.
    const frame = encodeSseFrame("activity", "hello\n");
    expect(frame).toBe("event: activity\ndata: hello\ndata: \n\n");
    // And with a multi-line trailing-newline input:
    const frame2 = encodeSseFrame("activity", "a\nb\n");
    expect(frame2).toBe("event: activity\ndata: a\ndata: b\ndata: \n\n");
  });

  it("encodeSseEvent emits the deterministic inbox payload key order", () => {
    // Rust emits keys in the order `last_poll, total, new_count`
    // with no whitespace (Json::Object). Our encoder must match.
    const frame = encodeSseEvent({
      kind: "inbox",
      last_poll: "2026-04-16T20:15:30Z",
      total: 422,
      new_count: 3,
    });
    expect(frame).toBe(
      'event: inbox\ndata: {"last_poll":"2026-04-16T20:15:30Z","total":422,"new_count":3}\n\n',
    );
  });

  it("exposes the canonical ready and keep-alive constants", () => {
    expect(SSE_READY_FRAME).toBe('event: ready\ndata: "subscribed"\n\n');
    expect(SSE_KEEPALIVE).toBe(": ping\n\n");
  });
});

/* ------------------------------------------------------------------ */
/* Integration tests — real bound server                               */
/* ------------------------------------------------------------------ */

async function startTestServer(ctx: Ctx, busOverride?: SseBus) {
  const controller = new AbortController();
  const server = await startHttpServer({
    httpPort: 0, // ephemeral port
    inboxPath: ctx.inbox,
    activityLogPath: ctx.activity,
    signal: controller.signal,
    bus: busOverride,
    logger: SILENT_LOGGER,
    // speed up keep-alive cadence for the test that covers it
    sseKeepAliveMs: 50,
  });
  return { controller, server };
}

describe("startHttpServer — route contracts", () => {
  let ctx: Ctx;
  let controller: AbortController;
  let server: Awaited<ReturnType<typeof startTestServer>>["server"];

  beforeEach(async () => {
    ctx = makeCtx();
  });
  afterEach(async () => {
    if (controller && !controller.signal.aborted) controller.abort();
    if (server) await server.done;
    rmSync(ctx.dir, { recursive: true, force: true });
  });

  it("GET / returns the dashboard HTML with the contract headers", async () => {
    ({ controller, server } = await startTestServer(ctx));
    const res = await fetchRaw(server.port, "/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["connection"]).toBe("close");
    expect(res.body.includes("<title>breeze</title>")).toBe(true);
    // Dashboard embeds all its JS and CSS inline; no external refs.
    expect(res.body.includes('new EventSource("/events")')).toBe(true);
  });

  it("GET /dashboard and GET /index.html are aliases", async () => {
    ({ controller, server } = await startTestServer(ctx));
    const a = await fetchRaw(server.port, "/dashboard");
    const b = await fetchRaw(server.port, "/index.html");
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.equals(b.body)).toBe(true);
  });

  it("GET /healthz returns 200 with body 'ok\\n'", async () => {
    ({ controller, server } = await startTestServer(ctx));
    const res = await fetchRaw(server.port, "/healthz");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(res.headers["content-length"]).toBe("3");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.toString("utf-8")).toBe("ok\n");
  });

  it("GET /inbox passes through inbox.json verbatim with JSON content-type", async () => {
    const inboxBody = '{"last_poll":"2026-04-16T20:15:30Z","notifications":[]}';
    writeFileSync(ctx.inbox, inboxBody, "utf-8");
    ({ controller, server } = await startTestServer(ctx));
    const res = await fetchRaw(server.port, "/inbox");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.toString("utf-8")).toBe(inboxBody);
  });

  it("GET /inbox?all=1 strips the query and still matches (contract §2.1)", async () => {
    writeFileSync(ctx.inbox, '{"last_poll":"x","notifications":[]}', "utf-8");
    ({ controller, server } = await startTestServer(ctx));
    const res = await fetchRaw(server.port, "/inbox?all=1");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
  });

  it("GET /inbox returns 404 text when the file is absent", async () => {
    ({ controller, server } = await startTestServer(ctx));
    const res = await fetchRaw(server.port, "/inbox");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(res.body.toString("utf-8")).toBe("inbox.json not found\n");
  });

  it("GET /activity returns [] when the file is absent (always 200)", async () => {
    ({ controller, server } = await startTestServer(ctx));
    const res = await fetchRaw(server.port, "/activity");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(res.body.toString("utf-8")).toBe("[]");
  });

  it("GET /activity tails the last 200 lines and joins without re-parse", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 250; i += 1) lines.push(`{"n":${i}}`);
    writeFileSync(ctx.activity, `${lines.join("\n")}\n`, "utf-8");
    ({ controller, server } = await startTestServer(ctx));
    const res = await fetchRaw(server.port, "/activity");
    expect(res.status).toBe(200);
    const body = res.body.toString("utf-8");
    expect(body.startsWith(`[{"n":50},{"n":51},`)).toBe(true);
    expect(body.endsWith(`{"n":249}]`)).toBe(true);
  });

  it("GET /nope returns 404 with 'not found\\n'", async () => {
    ({ controller, server } = await startTestServer(ctx));
    const res = await fetchRaw(server.port, "/nope");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(res.body.toString("utf-8")).toBe("not found\n");
  });

  it("POST /inbox is rejected as not-found (GET-only per contract §2)", async () => {
    ({ controller, server } = await startTestServer(ctx));
    const res = await fetchRaw(server.port, "/inbox", "POST");
    expect(res.status).toBe(404);
    expect(res.body.toString("utf-8")).toBe("not found\n");
  });
});

/* ------------------------------------------------------------------ */
/* SSE live stream                                                     */
/* ------------------------------------------------------------------ */

describe("startHttpServer — /events SSE stream", () => {
  let ctx: Ctx;
  let controller: AbortController;
  let server: Awaited<ReturnType<typeof startTestServer>>["server"];

  beforeEach(async () => {
    ctx = makeCtx();
  });
  afterEach(async () => {
    if (controller && !controller.signal.aborted) controller.abort();
    if (server) await server.done;
    rmSync(ctx.dir, { recursive: true, force: true });
  });

  it("emits 200 SSE headers + ready frame + bus events byte-for-byte", async () => {
    const manual = makeManualBus();
    ({ controller, server } = await startTestServer(ctx, manual.bus));

    // Open the SSE connection manually so we can read the raw bytes
    // and compare against the Rust fixture frames.
    const chunks: Buffer[] = [];
    const seenFrames: string[] = [];
    let sawReady = false;
    let sawInbox = false;

    const req = httpRequest({
      hostname: "127.0.0.1",
      port: server.port,
      path: "/events",
      method: "GET",
    });

    const done = new Promise<void>((resolve, reject) => {
      req.on("response", (res) => {
        expect(res.statusCode).toBe(200);
        expect(res.headers["content-type"]).toBe("text/event-stream");
        expect(res.headers["cache-control"]).toBe("no-store");
        expect(res.headers["connection"]).toBe("keep-alive");
        expect(res.headers["x-accel-buffering"]).toBe("no");
        res.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
          const combined = Buffer.concat(chunks).toString("utf-8");
          // Split into frames on blank-line terminators.
          const frames = combined.split("\n\n");
          // The last element is the in-progress frame (no trailing \n\n yet).
          for (let i = 0; i < frames.length - 1; i += 1) {
            const frame = frames[i] + "\n\n";
            if (seenFrames.includes(frame)) continue;
            seenFrames.push(frame);
            if (frame.startsWith("event: ready")) {
              expect(frame).toBe(SSE_READY_FRAME);
              sawReady = true;
              // Publish one real event now that we know the client
              // is subscribed.
              manual.emit({
                kind: "inbox",
                last_poll: "2026-04-16T20:15:30Z",
                total: 7,
                new_count: 2,
              });
            } else if (frame.startsWith("event: inbox")) {
              expect(frame).toBe(
                'event: inbox\ndata: {"last_poll":"2026-04-16T20:15:30Z","total":7,"new_count":2}\n\n',
              );
              sawInbox = true;
              // We've verified both frames; abort to finish.
              req.destroy();
              controller.abort();
              resolve();
            }
          }
        });
        res.on("end", () => resolve());
        res.on("error", (err) => reject(err));
      });
      req.on("error", (err) => {
        // Connection closed after we destroyed it — expected.
        if (sawReady && sawInbox) resolve();
        else reject(err);
      });
      req.end();
    });

    await done;
    expect(sawReady).toBe(true);
    expect(sawInbox).toBe(true);
  });

  it("emits a keep-alive `: ping\\n\\n` comment when the bus is idle", async () => {
    const manual = makeManualBus();
    ({ controller, server } = await startTestServer(ctx, manual.bus));

    let combined = "";

    const req = httpRequest({
      hostname: "127.0.0.1",
      port: server.port,
      path: "/events",
      method: "GET",
    });

    await new Promise<void>((resolve, reject) => {
      req.on("response", (res) => {
        res.on("data", (chunk: Buffer) => {
          combined += chunk.toString("utf-8");
          if (combined.includes(SSE_KEEPALIVE)) {
            req.destroy();
            controller.abort();
            resolve();
          }
        });
        res.on("end", () => resolve());
        res.on("error", reject);
      });
      req.on("error", (err) => {
        if (combined.includes(SSE_KEEPALIVE)) resolve();
        else reject(err);
      });
      req.end();
    });

    expect(combined).toContain(SSE_READY_FRAME);
    expect(combined).toContain(SSE_KEEPALIVE);
  });
});

/* ------------------------------------------------------------------ */
/* Graceful shutdown                                                   */
/* ------------------------------------------------------------------ */

describe("startHttpServer — graceful shutdown via AbortSignal", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(() => rmSync(ctx.dir, { recursive: true, force: true }));

  it("closes the listener and resolves `done` after abort, without dropping the in-flight request", async () => {
    writeFileSync(ctx.inbox, '{"last_poll":"x","notifications":[]}', "utf-8");
    const manual = makeManualBus();
    const controller = new AbortController();
    const server = await startHttpServer({
      httpPort: 0,
      inboxPath: ctx.inbox,
      activityLogPath: ctx.activity,
      signal: controller.signal,
      bus: manual.bus,
      logger: SILENT_LOGGER,
      sseKeepAliveMs: 1000,
    });

    // Fire one regular request, then abort before the next.
    const res = await fetchRaw(server.port, "/inbox");
    expect(res.status).toBe(200);

    controller.abort();
    await server.done;

    // After shutdown, new connections must fail (listener closed).
    let connectErr: NodeJS.ErrnoException | null = null;
    try {
      await fetchRaw(server.port, "/healthz");
    } catch (err) {
      connectErr = err as NodeJS.ErrnoException;
    }
    expect(connectErr).not.toBeNull();
    expect(["ECONNREFUSED", "ECONNRESET"]).toContain(connectErr?.code);
  });

  it("cancels in-flight SSE streams so the listener can close", async () => {
    const manual = makeManualBus();
    const controller = new AbortController();
    const server = await startHttpServer({
      httpPort: 0,
      inboxPath: ctx.inbox,
      activityLogPath: ctx.activity,
      signal: controller.signal,
      bus: manual.bus,
      logger: SILENT_LOGGER,
      sseKeepAliveMs: 10_000,
    });

    // Open an SSE connection. Wait until we have the ready frame so we
    // know the stream is active inside the server's bookkeeping.
    const req = httpRequest({
      hostname: "127.0.0.1",
      port: server.port,
      path: "/events",
      method: "GET",
    });
    await new Promise<void>((resolve, reject) => {
      req.on("response", (res) => {
        res.on("data", (chunk: Buffer) => {
          if (chunk.toString("utf-8").includes("event: ready")) resolve();
        });
        res.on("error", reject);
      });
      req.on("error", reject);
      req.end();
    });

    // Abort and expect `done` to resolve within a reasonable window.
    const closeStart = Date.now();
    controller.abort();
    await server.done;
    const closeMs = Date.now() - closeStart;
    // With no cancel wiring, server.close() would hang on the live
    // SSE conn forever. With the wiring, it should settle well under
    // a second.
    expect(closeMs).toBeLessThan(1_500);

    req.destroy();
  });
});
