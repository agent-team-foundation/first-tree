import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { adapterConfigs } from "../db/schema/adapter-configs.js";
import { chats } from "../db/schema/chats.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { messages } from "../db/schema/messages.js";
import { encryptCredentials } from "../services/crypto.js";
import { createKaelRuntime } from "../services/kael-runtime.js";
import { createTestAgent, createTestApp } from "./helpers.js";
import { DEFAULT_ORG_ID } from "./setup.js";

/** Test helper: assert value is defined and return narrowed type */
function defined<T>(value: T | undefined, msg = "Expected value to be defined"): T {
  if (value === undefined) throw new Error(msg);
  return value;
}

const ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const KAEL_ENDPOINT = "https://kael.example.com";
const KAEL_API_KEY = "test-kael-api-key";
const SERVER_URL = "https://hub.example.com";

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: "info",
    silent: vi.fn(),
  } as unknown as Parameters<typeof createKaelRuntime>[5];
}

// ---------------------------------------------------------------------------
// Platform schema validation (no DB required)
// ---------------------------------------------------------------------------
describe("Platform enum validation", () => {
  it("adapterPlatformSchema.parse('kael') succeeds", async () => {
    const { adapterPlatformSchema } = await import("@agent-team-foundation/first-tree-hub-shared");
    expect(adapterPlatformSchema.parse("kael")).toBe("kael");
  });

  it("adapterPlatformSchema.parse('invalid') throws", async () => {
    const { adapterPlatformSchema } = await import("@agent-team-foundation/first-tree-hub-shared");
    expect(() => adapterPlatformSchema.parse("invalid")).toThrow();
  });

  it("ADAPTER_PLATFORMS.KAEL equals 'kael'", async () => {
    const { ADAPTER_PLATFORMS } = await import("@agent-team-foundation/first-tree-hub-shared");
    expect(ADAPTER_PLATFORMS.KAEL).toBe("kael");
  });
});

// ---------------------------------------------------------------------------
// KaelRuntime (integration tests against test DB)
// ---------------------------------------------------------------------------
describe("KaelRuntime", () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---- helpers ----

  async function insertKaelConfig(agentId: string, opts: { status?: string; credentials?: unknown } = {}) {
    const creds =
      opts.credentials ??
      encryptCredentials(
        { kaelUserId: "kael-user-1", kaelProjectId: "kael-proj-1", agentToken: "kael-tok-1" },
        ENCRYPTION_KEY,
      );
    const [row] = await app.db
      .insert(adapterConfigs)
      .values({
        platform: "kael",
        agentId,
        credentials: creds,
        status: opts.status ?? "active",
      })
      .returning();
    return row;
  }

  async function insertFeishuConfig(agentId: string) {
    await app.db.insert(adapterConfigs).values({
      platform: "feishu",
      agentId,
      credentials: encryptCredentials({ app_id: "cli_test", app_secret: "sec" }, ENCRYPTION_KEY),
      status: "active",
    });
  }

  async function insertMessage(opts: {
    id: string;
    chatId: string;
    senderId: string;
    content: unknown;
    format?: string;
  }) {
    await app.db.insert(messages).values({
      id: opts.id,
      chatId: opts.chatId,
      senderId: opts.senderId,
      format: opts.format ?? "text",
      content: opts.content,
    });
  }

  async function insertInboxEntry(opts: {
    inboxId: string;
    messageId: string;
    chatId?: string;
    status?: string;
    retryCount?: number;
  }) {
    const [row] = await app.db
      .insert(inboxEntries)
      .values({
        inboxId: opts.inboxId,
        messageId: opts.messageId,
        chatId: opts.chatId ?? null,
        status: opts.status ?? "pending",
        retryCount: opts.retryCount ?? 0,
      })
      .returning();
    return row;
  }

  async function createChat(id: string) {
    await app.db.insert(chats).values({ id, type: "direct", organizationId: DEFAULT_ORG_ID });
  }

  // ---- reload() ----

  describe("reload()", () => {
    it("loads active kael adapter configs from DB", async () => {
      const { agent } = await createTestAgent(app, { name: "kael-reload-1" });
      await insertKaelConfig(agent.uuid);

      const log = createMockLogger();
      const runtime = createKaelRuntime(app.db, ENCRYPTION_KEY, KAEL_ENDPOINT, KAEL_API_KEY, SERVER_URL, log);
      await runtime.reload();

      // reload should have logged that config was loaded
      expect(log.info).toHaveBeenCalled();
      const infoMock = log.info as unknown as { mock: { calls: unknown[][] } };
      const infoArgs = infoMock.mock.calls.map((c) => (c[0] as Record<string, unknown>)?.agentId);
      expect(infoArgs).toContain(agent.uuid);

      // Verify config was loaded by sending a message through processOutbound
      const chatId = `chat-reload-1-${Date.now()}`;
      const msgId = `msg-reload-1-${Date.now()}`;
      await createChat(chatId);
      await insertMessage({ id: msgId, chatId, senderId: "sender-1", content: "hello" });
      await insertInboxEntry({ inboxId: agent.inboxId, messageId: msgId, chatId });

      const mockFetch = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve("") });
      vi.stubGlobal("fetch", mockFetch);

      const result = await runtime.processOutbound();
      expect(result.sent).toBe(1);
      expect(mockFetch).toHaveBeenCalledOnce();

      vi.unstubAllGlobals();
    });

    it("ignores non-kael configs", async () => {
      const { agent } = await createTestAgent(app, { name: "kael-ignore-feishu" });
      await insertFeishuConfig(agent.uuid);

      const runtime = createKaelRuntime(
        app.db,
        ENCRYPTION_KEY,
        KAEL_ENDPOINT,
        KAEL_API_KEY,
        SERVER_URL,
        createMockLogger(),
      );
      await runtime.reload();

      // processOutbound should do nothing since no kael configs were loaded
      const result = await runtime.processOutbound();
      expect(result.sent).toBe(0);
      expect(result.errors).toBe(0);
    });

    it("ignores inactive configs", async () => {
      const { agent } = await createTestAgent(app, { name: "kael-inactive" });
      await insertKaelConfig(agent.uuid, { status: "inactive" });

      const runtime = createKaelRuntime(
        app.db,
        ENCRYPTION_KEY,
        KAEL_ENDPOINT,
        KAEL_API_KEY,
        SERVER_URL,
        createMockLogger(),
      );
      await runtime.reload();

      const result = await runtime.processOutbound();
      expect(result.sent).toBe(0);
      expect(result.errors).toBe(0);
    });

    it("clears configs when KAEL_ENDPOINT is not set", async () => {
      const { agent } = await createTestAgent(app, { name: "kael-no-endpoint" });
      await insertKaelConfig(agent.uuid);

      // First load with endpoint
      const runtime = createKaelRuntime(
        app.db,
        ENCRYPTION_KEY,
        KAEL_ENDPOINT,
        KAEL_API_KEY,
        SERVER_URL,
        createMockLogger(),
      );
      await runtime.reload();

      // Create a new runtime without endpoint
      const runtimeNoEndpoint = createKaelRuntime(
        app.db,
        ENCRYPTION_KEY,
        undefined,
        undefined,
        SERVER_URL,
        createMockLogger(),
      );
      await runtimeNoEndpoint.reload();

      const result = await runtimeNoEndpoint.processOutbound();
      expect(result.sent).toBe(0);
      expect(result.errors).toBe(0);
    });

    it("handles decryption failures gracefully (logs error, skips config)", async () => {
      const { agent } = await createTestAgent(app, { name: "kael-bad-creds" });
      // Insert with invalid (non-encrypted) credentials
      await insertKaelConfig(agent.uuid, { credentials: "not-valid-encrypted-data" });

      const log = createMockLogger();
      const runtime = createKaelRuntime(app.db, ENCRYPTION_KEY, KAEL_ENDPOINT, KAEL_API_KEY, SERVER_URL, log);
      await runtime.reload();

      // Should have logged error but not thrown
      expect(log.error).toHaveBeenCalled();

      // processOutbound should do nothing since config was skipped
      const result = await runtime.processOutbound();
      expect(result.sent).toBe(0);
      expect(result.errors).toBe(0);
    });
  });

  // ---- processOutbound() ----

  describe("processOutbound()", () => {
    it("returns {sent:0, errors:0} when no configs loaded", async () => {
      const runtime = createKaelRuntime(
        app.db,
        ENCRYPTION_KEY,
        KAEL_ENDPOINT,
        KAEL_API_KEY,
        SERVER_URL,
        createMockLogger(),
      );
      // Don't call reload — no configs loaded
      const result = await runtime.processOutbound();
      expect(result).toEqual({ sent: 0, errors: 0 });
    });

    it("claims pending inbox entries for kael-bound agents", async () => {
      const { agent } = await createTestAgent(app, { name: "kael-claim" });
      await insertKaelConfig(agent.uuid);

      const runtime = createKaelRuntime(
        app.db,
        ENCRYPTION_KEY,
        KAEL_ENDPOINT,
        KAEL_API_KEY,
        SERVER_URL,
        createMockLogger(),
      );
      await runtime.reload();

      const chatId = `chat-claim-${Date.now()}`;
      const msgId = `msg-claim-${Date.now()}`;
      await createChat(chatId);
      await insertMessage({ id: msgId, chatId, senderId: "sender-1", content: "test message" });
      const entry = await insertInboxEntry({ inboxId: agent.inboxId, messageId: msgId, chatId });

      const mockFetch = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve("") });
      vi.stubGlobal("fetch", mockFetch);

      await runtime.processOutbound();

      // Entry should be acked (not pending anymore)
      const [updated] = await app.db
        .select()
        .from(inboxEntries)
        .where(eq(inboxEntries.id, defined(entry).id));
      expect(defined(updated).status).toBe("acked");

      vi.unstubAllGlobals();
    });

    it("POSTs correct payload to Kael API (verify URL, headers, body shape)", async () => {
      const { agent } = await createTestAgent(app, { name: "kael-payload" });
      const kaelCreds = { kaelUserId: "u-123", kaelProjectId: "p-456", agentToken: "tok-789" };
      await insertKaelConfig(agent.uuid, {
        credentials: encryptCredentials(kaelCreds, ENCRYPTION_KEY),
      });

      const runtime = createKaelRuntime(
        app.db,
        ENCRYPTION_KEY,
        KAEL_ENDPOINT,
        KAEL_API_KEY,
        SERVER_URL,
        createMockLogger(),
      );
      await runtime.reload();

      const chatId = `chat-payload-${Date.now()}`;
      const msgId = `msg-payload-${Date.now()}`;
      await createChat(chatId);
      await insertMessage({ id: msgId, chatId, senderId: "sender-abc", content: "Hello from hub" });
      await insertInboxEntry({ inboxId: agent.inboxId, messageId: msgId, chatId });

      const mockFetch = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve("") });
      vi.stubGlobal("fetch", mockFetch);

      await runtime.processOutbound();

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];

      // Verify URL
      expect(url).toBe(`${KAEL_ENDPOINT}/api/v1/hub/messages`);

      // Verify headers
      const headers = init.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers["X-Internal-API-Key"]).toBe(KAEL_API_KEY);
      expect(headers.Authorization).toBeUndefined();

      // Verify body shape
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.hub_chat_id).toBe(chatId);
      expect(body.hub_agent_id).toBe(agent.uuid);
      expect(body.hub_server_url).toBe(SERVER_URL);
      expect(body.hub_agent_token).toBe(kaelCreds.agentToken);
      expect(body.user_id).toBe(kaelCreds.kaelUserId);
      expect(body.project_id).toBe(kaelCreds.kaelProjectId);
      expect(body.message).toBe("Hello from hub");
      expect(body.sender_id).toBe("sender-abc");
      expect(body.format).toBe("text");

      vi.unstubAllGlobals();
    });

    it("ACKs entry on successful POST", async () => {
      const { agent } = await createTestAgent(app, { name: "kael-ack-ok" });
      await insertKaelConfig(agent.uuid);

      const runtime = createKaelRuntime(
        app.db,
        ENCRYPTION_KEY,
        KAEL_ENDPOINT,
        KAEL_API_KEY,
        SERVER_URL,
        createMockLogger(),
      );
      await runtime.reload();

      const chatId = `chat-ack-ok-${Date.now()}`;
      const msgId = `msg-ack-ok-${Date.now()}`;
      await createChat(chatId);
      await insertMessage({ id: msgId, chatId, senderId: "s", content: "ok" });
      const entry = await insertInboxEntry({ inboxId: agent.inboxId, messageId: msgId, chatId });

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve("") }));

      await runtime.processOutbound();

      const [updated] = await app.db
        .select()
        .from(inboxEntries)
        .where(eq(inboxEntries.id, defined(entry).id));
      expect(defined(updated).status).toBe("acked");
      expect(defined(updated).ackedAt).not.toBeNull();

      vi.unstubAllGlobals();
    });

    it("NACKs entry on HTTP error (4xx, 5xx)", async () => {
      const { agent } = await createTestAgent(app, { name: "kael-nack-http" });
      await insertKaelConfig(agent.uuid);

      const runtime = createKaelRuntime(
        app.db,
        ENCRYPTION_KEY,
        KAEL_ENDPOINT,
        KAEL_API_KEY,
        SERVER_URL,
        createMockLogger(),
      );
      await runtime.reload();

      const chatId = `chat-nack-http-${Date.now()}`;
      const msgId = `msg-nack-http-${Date.now()}`;
      await createChat(chatId);
      await insertMessage({ id: msgId, chatId, senderId: "s", content: "fail" });
      const entry = await insertInboxEntry({ inboxId: agent.inboxId, messageId: msgId, chatId });

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          text: () => Promise.resolve("Internal Server Error"),
        }),
      );

      const result = await runtime.processOutbound();
      expect(result.errors).toBe(1);

      const [updated] = await app.db
        .select()
        .from(inboxEntries)
        .where(eq(inboxEntries.id, defined(entry).id));
      // NACKed back to pending with retry_count incremented
      expect(defined(updated).status).toBe("pending");
      expect(defined(updated).retryCount).toBe(1);

      vi.unstubAllGlobals();
    });

    it("NACKs entry on network error", async () => {
      const { agent } = await createTestAgent(app, { name: "kael-nack-net" });
      await insertKaelConfig(agent.uuid);

      const runtime = createKaelRuntime(
        app.db,
        ENCRYPTION_KEY,
        KAEL_ENDPOINT,
        KAEL_API_KEY,
        SERVER_URL,
        createMockLogger(),
      );
      await runtime.reload();

      const chatId = `chat-nack-net-${Date.now()}`;
      const msgId = `msg-nack-net-${Date.now()}`;
      await createChat(chatId);
      await insertMessage({ id: msgId, chatId, senderId: "s", content: "net-fail" });
      const entry = await insertInboxEntry({ inboxId: agent.inboxId, messageId: msgId, chatId });

      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

      const result = await runtime.processOutbound();
      expect(result.errors).toBe(1);

      const [updated] = await app.db
        .select()
        .from(inboxEntries)
        .where(eq(inboxEntries.id, defined(entry).id));
      expect(defined(updated).status).toBe("pending");
      expect(defined(updated).retryCount).toBe(1);

      vi.unstubAllGlobals();
    });

    it("marks entry as failed after MAX_RETRY_COUNT (3) retries", async () => {
      const { agent } = await createTestAgent(app, { name: "kael-max-retry" });
      await insertKaelConfig(agent.uuid);

      const runtime = createKaelRuntime(
        app.db,
        ENCRYPTION_KEY,
        KAEL_ENDPOINT,
        KAEL_API_KEY,
        SERVER_URL,
        createMockLogger(),
      );
      await runtime.reload();

      const chatId = `chat-max-retry-${Date.now()}`;
      const msgId = `msg-max-retry-${Date.now()}`;
      await createChat(chatId);
      await insertMessage({ id: msgId, chatId, senderId: "s", content: "retry-exhaust" });
      // Start with retryCount already at 3 (the max)
      const entry = await insertInboxEntry({
        inboxId: agent.inboxId,
        messageId: msgId,
        chatId,
        retryCount: 3,
      });

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 503,
          text: () => Promise.resolve("Service Unavailable"),
        }),
      );

      await runtime.processOutbound();

      const [updated] = await app.db
        .select()
        .from(inboxEntries)
        .where(eq(inboxEntries.id, defined(entry).id));
      expect(defined(updated).status).toBe("failed");

      vi.unstubAllGlobals();
    });

    it("does not claim entries for non-kael agents", async () => {
      // Create agent with feishu adapter only (no kael)
      const { agent } = await createTestAgent(app, { name: "kael-non-kael-agent" });
      await insertFeishuConfig(agent.uuid);

      // Create a kael-bound agent to load configs
      const { agent: kaelAgent } = await createTestAgent(app, { name: "kael-actual-agent" });
      await insertKaelConfig(kaelAgent.uuid);

      const runtime = createKaelRuntime(
        app.db,
        ENCRYPTION_KEY,
        KAEL_ENDPOINT,
        KAEL_API_KEY,
        SERVER_URL,
        createMockLogger(),
      );
      await runtime.reload();

      // Add a pending entry for the feishu-only agent
      const chatId = `chat-non-kael-${Date.now()}`;
      const msgId = `msg-non-kael-${Date.now()}`;
      await createChat(chatId);
      await insertMessage({ id: msgId, chatId, senderId: "s", content: "not for kael" });
      const entry = await insertInboxEntry({ inboxId: agent.inboxId, messageId: msgId, chatId });

      const mockFetch = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve("") });
      vi.stubGlobal("fetch", mockFetch);

      await runtime.processOutbound();

      // The feishu agent's entry should still be pending
      const [unchanged] = await app.db
        .select()
        .from(inboxEntries)
        .where(eq(inboxEntries.id, defined(entry).id));
      expect(defined(unchanged).status).toBe("pending");

      vi.unstubAllGlobals();
    });

    it("uses X-Internal-API-Key header (not Authorization: Bearer)", async () => {
      const { agent } = await createTestAgent(app, { name: "kael-header-check" });
      await insertKaelConfig(agent.uuid);

      const runtime = createKaelRuntime(
        app.db,
        ENCRYPTION_KEY,
        KAEL_ENDPOINT,
        KAEL_API_KEY,
        SERVER_URL,
        createMockLogger(),
      );
      await runtime.reload();

      const chatId = `chat-header-${Date.now()}`;
      const msgId = `msg-header-${Date.now()}`;
      await createChat(chatId);
      await insertMessage({ id: msgId, chatId, senderId: "s", content: "header check" });
      await insertInboxEntry({ inboxId: agent.inboxId, messageId: msgId, chatId });

      const mockFetch = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve("") });
      vi.stubGlobal("fetch", mockFetch);

      await runtime.processOutbound();

      expect(mockFetch).toHaveBeenCalledOnce();
      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;

      // Must use X-Internal-API-Key
      expect(headers["X-Internal-API-Key"]).toBe(KAEL_API_KEY);
      // Must NOT use Authorization: Bearer
      expect(headers.Authorization).toBeUndefined();

      vi.unstubAllGlobals();
    });
  });

  // ---- shutdown() ----

  describe("shutdown()", () => {
    it("clears agent configs", async () => {
      const { agent } = await createTestAgent(app, { name: "kael-shutdown-clear" });
      await insertKaelConfig(agent.uuid);

      const runtime = createKaelRuntime(
        app.db,
        ENCRYPTION_KEY,
        KAEL_ENDPOINT,
        KAEL_API_KEY,
        SERVER_URL,
        createMockLogger(),
      );
      await runtime.reload();

      runtime.shutdown();

      // After shutdown, processOutbound should return immediately
      const result = await runtime.processOutbound();
      expect(result).toEqual({ sent: 0, errors: 0 });
    });

    it("processOutbound returns immediately after shutdown (no fetch calls)", async () => {
      const { agent } = await createTestAgent(app, { name: "kael-shutdown-noop" });
      await insertKaelConfig(agent.uuid);

      const runtime = createKaelRuntime(
        app.db,
        ENCRYPTION_KEY,
        KAEL_ENDPOINT,
        KAEL_API_KEY,
        SERVER_URL,
        createMockLogger(),
      );
      await runtime.reload();

      // Add pending entry
      const chatId = `chat-shutdown-${Date.now()}`;
      const msgId = `msg-shutdown-${Date.now()}`;
      await createChat(chatId);
      await insertMessage({ id: msgId, chatId, senderId: "s", content: "after shutdown" });
      const entry = await insertInboxEntry({ inboxId: agent.inboxId, messageId: msgId, chatId });

      const mockFetch = vi.fn();
      vi.stubGlobal("fetch", mockFetch);

      runtime.shutdown();

      const result = await runtime.processOutbound();
      expect(result).toEqual({ sent: 0, errors: 0 });
      // fetch should never be called after shutdown
      expect(mockFetch).not.toHaveBeenCalled();

      // Entry should still be pending (not processed)
      const [unchanged] = await app.db
        .select()
        .from(inboxEntries)
        .where(eq(inboxEntries.id, defined(entry).id));
      expect(defined(unchanged).status).toBe("pending");

      vi.unstubAllGlobals();
    });
  });

  // ---- Context Tree AGENT.md injection ----

  describe("Context Tree AGENT.md injection", () => {
    let tmpDir: string;

    beforeAll(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "kael-ctx-"));
    });

    afterAll(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("reload() reads AGENT.md and processOutbound() includes agents_md in payload", async () => {
      const agentMdContent = "# Team Instructions\nAlways respond in English.";
      writeFileSync(join(tmpDir, "AGENT.md"), agentMdContent, "utf-8");

      const { agent } = await createTestAgent(app, { name: "kael-ctx-inject" });
      await insertKaelConfig(agent.uuid);

      const log = createMockLogger();
      const runtime = createKaelRuntime(app.db, ENCRYPTION_KEY, KAEL_ENDPOINT, KAEL_API_KEY, SERVER_URL, log, tmpDir);
      await runtime.reload();

      // Verify AGENT.md was loaded (logged)
      const infoMock = log.info as unknown as { mock: { calls: unknown[][] } };
      const loadedLog = infoMock.mock.calls.some((c) => typeof c[0] === "string" && c[0].includes("Loaded AGENT.md"));
      expect(loadedLog).toBe(true);

      // Send a message and verify payload includes agents_md
      const chatId = `chat-ctx-inject-${Date.now()}`;
      const msgId = `msg-ctx-inject-${Date.now()}`;
      await createChat(chatId);
      await insertMessage({ id: msgId, chatId, senderId: "s", content: "ctx test" });
      await insertInboxEntry({ inboxId: agent.inboxId, messageId: msgId, chatId });

      const mockFetch = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve("") });
      vi.stubGlobal("fetch", mockFetch);

      await runtime.processOutbound();

      expect(mockFetch).toHaveBeenCalledOnce();
      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.agents_md).toBe(agentMdContent);

      vi.unstubAllGlobals();
    });

    it("payload omits agents_md when AGENT.md does not exist", async () => {
      const emptyDir = mkdtempSync(join(tmpdir(), "kael-ctx-empty-"));

      const { agent } = await createTestAgent(app, { name: "kael-ctx-no-file" });
      await insertKaelConfig(agent.uuid);

      const runtime = createKaelRuntime(
        app.db,
        ENCRYPTION_KEY,
        KAEL_ENDPOINT,
        KAEL_API_KEY,
        SERVER_URL,
        createMockLogger(),
        emptyDir,
      );
      await runtime.reload();

      const chatId = `chat-ctx-nofile-${Date.now()}`;
      const msgId = `msg-ctx-nofile-${Date.now()}`;
      await createChat(chatId);
      await insertMessage({ id: msgId, chatId, senderId: "s", content: "no ctx" });
      await insertInboxEntry({ inboxId: agent.inboxId, messageId: msgId, chatId });

      const mockFetch = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve("") });
      vi.stubGlobal("fetch", mockFetch);

      await runtime.processOutbound();

      expect(mockFetch).toHaveBeenCalledOnce();
      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.agents_md).toBeUndefined();

      vi.unstubAllGlobals();
      rmSync(emptyDir, { recursive: true, force: true });
    });

    it("payload omits agents_md when contextTreeDir is not provided", async () => {
      const { agent } = await createTestAgent(app, { name: "kael-ctx-no-dir" });
      await insertKaelConfig(agent.uuid);

      const runtime = createKaelRuntime(
        app.db,
        ENCRYPTION_KEY,
        KAEL_ENDPOINT,
        KAEL_API_KEY,
        SERVER_URL,
        createMockLogger(),
      );
      await runtime.reload();

      const chatId = `chat-ctx-nodir-${Date.now()}`;
      const msgId = `msg-ctx-nodir-${Date.now()}`;
      await createChat(chatId);
      await insertMessage({ id: msgId, chatId, senderId: "s", content: "no dir" });
      await insertInboxEntry({ inboxId: agent.inboxId, messageId: msgId, chatId });

      const mockFetch = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve("") });
      vi.stubGlobal("fetch", mockFetch);

      await runtime.processOutbound();

      expect(mockFetch).toHaveBeenCalledOnce();
      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.agents_md).toBeUndefined();

      vi.unstubAllGlobals();
    });

    it("reload() refreshes agents_md when AGENT.md content changes", async () => {
      const dir = mkdtempSync(join(tmpdir(), "kael-ctx-refresh-"));
      writeFileSync(join(dir, "AGENT.md"), "# Version 1", "utf-8");

      const { agent } = await createTestAgent(app, { name: "kael-ctx-refresh" });
      await insertKaelConfig(agent.uuid);

      const runtime = createKaelRuntime(
        app.db,
        ENCRYPTION_KEY,
        KAEL_ENDPOINT,
        KAEL_API_KEY,
        SERVER_URL,
        createMockLogger(),
        dir,
      );
      await runtime.reload();

      // Update AGENT.md content
      writeFileSync(join(dir, "AGENT.md"), "# Version 2 — updated instructions", "utf-8");
      await runtime.reload();

      const chatId = `chat-ctx-refresh-${Date.now()}`;
      const msgId = `msg-ctx-refresh-${Date.now()}`;
      await createChat(chatId);
      await insertMessage({ id: msgId, chatId, senderId: "s", content: "refresh" });
      await insertInboxEntry({ inboxId: agent.inboxId, messageId: msgId, chatId });

      const mockFetch = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve("") });
      vi.stubGlobal("fetch", mockFetch);

      await runtime.processOutbound();

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.agents_md).toBe("# Version 2 — updated instructions");

      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true, force: true });
    });

    it("reload() clears agents_md when AGENT.md is deleted between reloads", async () => {
      const dir = mkdtempSync(join(tmpdir(), "kael-ctx-delete-"));
      const agentMdPath = join(dir, "AGENT.md");
      writeFileSync(agentMdPath, "# Will be deleted", "utf-8");

      const { agent } = await createTestAgent(app, { name: "kael-ctx-delete" });
      await insertKaelConfig(agent.uuid);

      const runtime = createKaelRuntime(
        app.db,
        ENCRYPTION_KEY,
        KAEL_ENDPOINT,
        KAEL_API_KEY,
        SERVER_URL,
        createMockLogger(),
        dir,
      );
      await runtime.reload();

      // Delete AGENT.md and reload
      rmSync(agentMdPath);
      await runtime.reload();

      const chatId = `chat-ctx-delete-${Date.now()}`;
      const msgId = `msg-ctx-delete-${Date.now()}`;
      await createChat(chatId);
      await insertMessage({ id: msgId, chatId, senderId: "s", content: "deleted" });
      await insertInboxEntry({ inboxId: agent.inboxId, messageId: msgId, chatId });

      const mockFetch = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve("") });
      vi.stubGlobal("fetch", mockFetch);

      await runtime.processOutbound();

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.agents_md).toBeUndefined();

      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true, force: true });
    });

    it("reload() handles readFileSync error gracefully (logs warning, clears agentsMd)", async () => {
      const dir = mkdtempSync(join(tmpdir(), "kael-ctx-readerr-"));
      const agentMdPath = join(dir, "AGENT.md");
      writeFileSync(agentMdPath, "# Readable initially", "utf-8");

      const { agent } = await createTestAgent(app, { name: "kael-ctx-readerr" });
      await insertKaelConfig(agent.uuid);

      const log = createMockLogger();
      const runtime = createKaelRuntime(app.db, ENCRYPTION_KEY, KAEL_ENDPOINT, KAEL_API_KEY, SERVER_URL, log, dir);

      // First reload succeeds
      await runtime.reload();

      // Make file unreadable and reload — should catch error, clear agentsMd
      chmodSync(agentMdPath, 0o000);
      await runtime.reload();

      expect(log.warn).toHaveBeenCalled();

      // Payload should not include agents_md
      const chatId = `chat-ctx-readerr-${Date.now()}`;
      const msgId = `msg-ctx-readerr-${Date.now()}`;
      await createChat(chatId);
      await insertMessage({ id: msgId, chatId, senderId: "s", content: "err" });
      await insertInboxEntry({ inboxId: agent.inboxId, messageId: msgId, chatId });

      const mockFetch = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve("") });
      vi.stubGlobal("fetch", mockFetch);

      await runtime.processOutbound();

      expect(mockFetch).toHaveBeenCalledOnce();
      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.agents_md).toBeUndefined();

      vi.unstubAllGlobals();
      // Restore permission before cleanup
      chmodSync(agentMdPath, 0o644);
      rmSync(dir, { recursive: true, force: true });
    });

    it("payload omits agents_md when AGENT.md is empty (falsy check)", async () => {
      const dir = mkdtempSync(join(tmpdir(), "kael-ctx-empty-file-"));
      writeFileSync(join(dir, "AGENT.md"), "", "utf-8");

      const { agent } = await createTestAgent(app, { name: "kael-ctx-empty-file" });
      await insertKaelConfig(agent.uuid);

      const runtime = createKaelRuntime(
        app.db,
        ENCRYPTION_KEY,
        KAEL_ENDPOINT,
        KAEL_API_KEY,
        SERVER_URL,
        createMockLogger(),
        dir,
      );
      await runtime.reload();

      const chatId = `chat-ctx-emptyfile-${Date.now()}`;
      const msgId = `msg-ctx-emptyfile-${Date.now()}`;
      await createChat(chatId);
      await insertMessage({ id: msgId, chatId, senderId: "s", content: "empty file" });
      await insertInboxEntry({ inboxId: agent.inboxId, messageId: msgId, chatId });

      const mockFetch = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve("") });
      vi.stubGlobal("fetch", mockFetch);

      await runtime.processOutbound();

      expect(mockFetch).toHaveBeenCalledOnce();
      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      // Empty string is falsy, so agents_md should not be included
      expect(body.agents_md).toBeUndefined();

      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true, force: true });
    });
  });
});
