import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyBaseLogger } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "../db/connection.js";
import { encryptCredentials } from "../services/crypto.js";
import { createKaelRuntime } from "../services/kael-runtime.js";

const key = "00".repeat(32);

type FakeDb = {
  db: Database;
  execute: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};

type SelectResult = {
  kind: "direct" | "limit";
  rows: unknown[];
};

function direct(rows: unknown[]): SelectResult {
  return { kind: "direct", rows };
}

function limited(rows: unknown[]): SelectResult {
  return { kind: "limit", rows };
}

function createFakeDb(selectResults: SelectResult[], executeResults: Array<unknown[] | Error>): FakeDb {
  const execute = vi.fn(async () => {
    const result = executeResults.shift();
    if (result instanceof Error) throw result;
    return result ?? [];
  });
  const select = vi.fn(() => {
    const result = selectResults.shift() ?? direct([]);
    return {
      from: () => ({
        where: () =>
          result.kind === "direct"
            ? Promise.resolve(result.rows)
            : {
                limit: vi.fn(async () => result.rows),
              },
      }),
    };
  });
  const update = vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(async () => {}),
    })),
  }));
  const db = { execute, select, update };

  // Test double implements only the query-builder methods this service calls.
  return { db: db as unknown as Database, execute, select, update };
}

function createLog(): FastifyBaseLogger {
  const log = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  // Test double implements the logger methods used by createKaelRuntime.
  return log as unknown as FastifyBaseLogger;
}

function encryptedKaelCredentials(): string {
  return encryptCredentials(
    {
      kaelUserId: "kael-user-1",
      kaelProjectId: "kael-project-1",
      agentToken: "agent-token-1",
    },
    key,
  );
}

function activeConfig(credentials = encryptedKaelCredentials()): Record<string, unknown> {
  return {
    id: 7,
    platform: "kael",
    status: "active",
    agentId: "agent-1",
    credentials,
  };
}

function message(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "msg-1",
    chatId: "chat-1",
    senderId: "sender-1",
    format: "text",
    content: { text: "hello" },
    ...overrides,
  };
}

describe("createKaelRuntime", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "first-tree-kael-"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("stays idle when required runtime configuration is missing", async () => {
    const fake = createFakeDb([], []);
    const log = createLog();
    const runtime = createKaelRuntime(fake.db, undefined, "https://kael.example", undefined, "https://hub", log);

    await runtime.reload();
    expect(log.warn).toHaveBeenCalledWith("Encryption key not set — Kael runtime disabled");
    expect(await runtime.processOutbound()).toEqual({ sent: 0, errors: 0 });

    const idleRuntime = createKaelRuntime(fake.db, key, undefined, undefined, "https://hub", log);
    await idleRuntime.reload();
    expect(log.debug).toHaveBeenCalledWith("KAEL_ENDPOINT not configured — Kael runtime idle");
    expect(await idleRuntime.processOutbound()).toEqual({ sent: 0, errors: 0 });
  });

  it("loads active configs, forwards outbound entries, and removes inactive configs on reload", async () => {
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, "AGENT.md"), "Context instructions");
    const fake = createFakeDb(
      [direct([activeConfig()]), limited([message()]), direct([])],
      [
        [{ uuid: "agent-1", inbox_id: "inbox-1" }],
        [{ id: 1, inbox_id: "inbox-1", message_id: "msg-1", chat_id: null }],
      ],
    );
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const log = createLog();
    const runtime = createKaelRuntime(
      fake.db,
      key,
      "https://kael.example",
      "internal-key",
      "https://hub.example",
      log,
      tmp,
    );

    await runtime.reload();
    expect(log.info).toHaveBeenCalledWith({ configId: 7, agentId: "agent-1" }, "Loaded Kael adapter config");
    expect(log.info).toHaveBeenCalledWith("Loaded AGENT.md from Context Tree (%d chars)", 20);

    await expect(runtime.processOutbound()).resolves.toEqual({ sent: 1, errors: 0 });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://kael.example/api/v1/hub/messages",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-Internal-API-Key": "internal-key" }),
        body: expect.stringContaining('"agents_md":"Context instructions"'),
      }),
    );
    expect(fake.update).toHaveBeenCalledTimes(1);

    await runtime.reload();
    expect(log.info).toHaveBeenCalledWith({ agentId: "agent-1" }, "Removed inactive Kael adapter config");
    expect(await runtime.processOutbound()).toEqual({ sent: 0, errors: 0 });
  });

  it("acks claimed entries that no longer have a message or loaded config", async () => {
    const fake = createFakeDb(
      [direct([activeConfig()]), limited([]), limited([message({ id: "msg-2" })])],
      [
        [{ uuid: "agent-1", inbox_id: "inbox-1" }],
        [
          { id: 1, inbox_id: "inbox-1", message_id: "missing", chat_id: "chat-1" },
          { id: 2, inbox_id: "unknown-inbox", message_id: "msg-2", chat_id: "chat-1" },
        ],
      ],
    );
    const runtime = createKaelRuntime(fake.db, key, "https://kael.example", undefined, "https://hub", createLog());

    await runtime.reload();

    await expect(runtime.processOutbound()).resolves.toEqual({ sent: 0, errors: 0 });
    expect(fake.update).toHaveBeenCalledTimes(2);
  });

  it("nacks rejected sends and reports claim failures", async () => {
    const rejected = createFakeDb(
      [direct([activeConfig()]), limited([message({ content: "plain text" })])],
      [
        [{ uuid: "agent-1", inbox_id: "inbox-1" }],
        [{ id: 1, inbox_id: "inbox-1", message_id: "msg-1", chat_id: "chat-override" }],
      ],
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 502 })),
    );
    const rejectedLog = createLog();
    const rejectedRuntime = createKaelRuntime(
      rejected.db,
      key,
      "https://kael.example",
      undefined,
      "https://hub",
      rejectedLog,
    );

    await rejectedRuntime.reload();
    await expect(rejectedRuntime.processOutbound()).resolves.toEqual({ sent: 0, errors: 1 });
    expect(rejected.execute).toHaveBeenCalledTimes(3);
    expect(rejectedLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ entryId: 1, status: 502 }),
      "Kael API rejected outbound message",
    );

    const claimFailure = createFakeDb(
      [direct([activeConfig()])],
      [[{ uuid: "agent-1", inbox_id: "inbox-1" }], new Error("claim failed")],
    );
    const claimLog = createLog();
    const claimRuntime = createKaelRuntime(
      claimFailure.db,
      key,
      "https://kael.example",
      undefined,
      "https://hub",
      claimLog,
    );

    await claimRuntime.reload();
    await expect(claimRuntime.processOutbound()).resolves.toEqual({ sent: 0, errors: 1 });
    expect(claimLog.error).toHaveBeenCalledWith({ err: expect.any(Error) }, "Kael claim error");
  });

  it("skips configs with bad credentials or inactive agents and stops after shutdown", async () => {
    const fake = createFakeDb([direct([activeConfig("not-valid-ciphertext"), activeConfig()])], [[]]);
    const log = createLog();
    const runtime = createKaelRuntime(fake.db, key, "https://kael.example", undefined, "https://hub", log);

    await runtime.reload();

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ configId: 7, err: expect.any(Error) }),
      "Failed to decrypt Kael adapter credentials",
    );
    expect(log.warn).toHaveBeenCalledWith(
      { configId: 7, agentId: "agent-1" },
      "Kael config agent not found or inactive",
    );

    runtime.shutdown();
    expect(await runtime.processOutbound()).toEqual({ sent: 0, errors: 0 });
  });
});
