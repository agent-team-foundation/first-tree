import { parseLandingCampaignTrialChatMetadata } from "@first-tree/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { chats } from "../db/schema/chats.js";
import { clients } from "../db/schema/clients.js";
import { contextTreeIoEvents } from "../db/schema/context-tree-io-events.js";
import { members } from "../db/schema/members.js";
import { users } from "../db/schema/users.js";
import { createAgent } from "../services/agent.js";
import * as contextTreeIoService from "../services/context-tree-io.js";
import { buildLandingCampaignChatMetadata } from "../services/landing-campaigns/metadata.js";
import { putOrgSetting } from "../services/org-settings.js";
import { resolveDefaultOrgId } from "../services/organization.js";
import * as sessionEventService from "../services/session-event.js";
import { uuidv7 } from "../uuid.js";
import { createTestApp } from "./helpers.js";

/**
 * S10 (NC2 backend) — WS protocol end-to-end.
 *
 * Exercises the full client-to-server flow:
 *   1. `session:event` WS frame ⇒ row lands in `session_events`.
 *   2. `session:state { state: "evicted" }` WS frame ⇒ persisted events
 *      for that (agent, chat) are cleared (D4 eviction hook).
 *
 * Both behaviors were previously wired to `session:output` and
 * `sessionOutputService`; this test protects the new protocol from
 * regression without booting a real Claude Code session.
 */
describe("Agent WS — session event protocol (S10)", () => {
  let app: FastifyInstance;
  let wsUrl: string;
  const jwtSecret = process.env.JWT_SECRET ?? "test-jwt-secret-key-for-vitest";

  async function signMemberJwt(
    userId: string,
    memberId: string,
    organizationId: string,
    role: string,
  ): Promise<string> {
    const secret = new TextEncoder().encode(jwtSecret);
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      sub: userId,
      memberId,
      organizationId,
      role,
      type: "access",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(secret);
  }

  async function seedBoundAgent(suffix: string, runtimeProvider: "claude-code" | "codex" = "claude-code") {
    const orgId = await resolveDefaultOrgId(app.db);
    const userId = uuidv7();
    const memberId = uuidv7();
    const clientId = `cli-evt-${suffix}-${crypto.randomUUID().slice(0, 6)}`;
    const role = "admin";

    const agent = await app.db.transaction(async (tx) => {
      await tx.insert(users).values({
        id: userId,
        username: `evt-user-${suffix}-${crypto.randomUUID().slice(0, 6)}`,
        passwordHash: "x",
        displayName: `Evt User ${suffix}`,
      });

      const humanAgent = await createAgent(tx as unknown as typeof app.db, {
        name: `evt-human-${suffix}-${crypto.randomUUID().slice(0, 6)}`,
        type: "human",
        displayName: `Evt Human ${suffix}`,
        source: "admin-api",
        managerId: memberId,
        organizationId: orgId,
      });

      await tx.insert(members).values({
        id: memberId,
        userId,
        organizationId: orgId,
        agentId: humanAgent.uuid,
        role,
      });

      await tx.insert(clients).values({
        id: clientId,
        userId,
        organizationId: orgId,
        status: "connected",
      });

      return createAgent(tx as unknown as typeof app.db, {
        name: `evt-agent-${suffix}-${crypto.randomUUID().slice(0, 6)}`,
        type: "agent",
        displayName: `Evt Agent ${suffix}`,
        source: "admin-api",
        managerId: memberId,
        clientId,
        organizationId: orgId,
        runtimeProvider,
      });
    });

    const token = await signMemberJwt(userId, memberId, orgId, role);
    return { agent, token, clientId, organizationId: orgId, memberId, userId };
  }

  function waitForFrame(ws: WebSocket, match: (m: unknown) => boolean, timeoutMs = 5000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.off("message", onMessage);
        reject(new Error(`timeout waiting for frame (${timeoutMs}ms)`));
      }, timeoutMs);
      const onMessage = (raw: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (match(msg)) {
            clearTimeout(timer);
            ws.off("message", onMessage);
            resolve(msg);
          }
        } catch {
          // ignore non-JSON
        }
      };
      ws.on("message", onMessage);
    });
  }

  async function openBoundSocket(seed: Awaited<ReturnType<typeof seedBoundAgent>>): Promise<WebSocket> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    ws.send(JSON.stringify({ type: "auth", token: seed.token }));
    await waitForFrame(ws, (m) => (m as { type?: string }).type === "auth:ok");

    ws.send(JSON.stringify({ type: "client:register", clientId: seed.clientId }));
    await waitForFrame(ws, (m) => (m as { type?: string }).type === "client:registered");

    ws.send(
      JSON.stringify({
        type: "agent:bind",
        agentId: seed.agent.uuid,
        ref: "bind-1",
        // Match the seeded agent's `runtime_provider` so the post-0026
        // RUNTIME_PROVIDER_MISMATCH check passes.
        runtimeType: seed.agent.runtimeProvider,
        runtimeVersion: "0.0.0",
      }),
    );
    await waitForFrame(ws, (m) => (m as { type?: string }).type === "agent:bound");

    return ws;
  }

  async function waitForCondition<T>(fn: () => Promise<T | null>, timeoutMs = 3000, stepMs = 50): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await fn();
      if (value !== null && value !== undefined) return value;
      await new Promise((r) => setTimeout(r, stepMs));
    }
    throw new Error(`condition not met within ${timeoutMs}ms`);
  }

  beforeAll(async () => {
    app = await createTestApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    if (!addr || typeof addr === "string") throw new Error("test server has no address");
    wsUrl = `ws://127.0.0.1:${addr.port}/api/v1/agent/ws/client`;
  });

  afterAll(async () => {
    await app?.close();
  });

  it("persists a `session:event` frame into session_events", async () => {
    const seed = await seedBoundAgent("persist");
    const ws = await openBoundSocket(seed);
    const chatId = `chat-${crypto.randomUUID()}`;

    try {
      ws.send(
        JSON.stringify({
          type: "session:event",
          agentId: seed.agent.uuid,
          chatId,
          event: {
            kind: "tool_call",
            payload: {
              toolUseId: "tu-42",
              name: "Bash",
              args: { command: "ls" },
              status: "ok",
              durationMs: 15,
              resultPreview: "a b c",
            },
          },
        }),
      );

      const listed = await waitForCondition(async () => {
        const { items } = await sessionEventService.listEvents(app.db, seed.agent.uuid, chatId, { limit: 10 });
        return items.length > 0 ? items : null;
      });

      expect(listed).toHaveLength(1);
      const ev = listed[0];
      if (!ev) throw new Error("expected event");
      expect(ev.kind).toBe("tool_call");
      expect(ev.seq).toBe(1);
      const payload = ev.payload as { toolUseId: string; name: string; status: string; durationMs?: number };
      expect(payload.toolUseId).toBe("tu-42");
      expect(payload.name).toBe("Bash");
      expect(payload.status).toBe("ok");
      expect(payload.durationMs).toBe(15);
    } finally {
      ws.close();
      await new Promise<void>((r) => ws.once("close", () => r()));
    }
  }, 15000);

  it("accepts a confirmed `session:event` only after persistence succeeds", async () => {
    const seed = await seedBoundAgent("confirm-accept");
    const ws = await openBoundSocket(seed);
    const chatId = `chat-${crypto.randomUUID()}`;
    const ref = `event-${crypto.randomUUID()}`;

    try {
      ws.send(
        JSON.stringify({
          type: "session:event",
          ref,
          agentId: seed.agent.uuid,
          chatId,
          event: {
            kind: "error",
            payload: { source: "runtime", message: "confirmed failure" },
          },
        }),
      );

      const accepted = (await waitForFrame(
        ws,
        (m) =>
          (m as { type?: string; ref?: string }).type === "session:event:accepted" &&
          (m as { ref?: string }).ref === ref,
      )) as { type: string; ref: string; agentId: string; chatId: string };

      expect(accepted).toMatchObject({
        type: "session:event:accepted",
        ref,
        agentId: seed.agent.uuid,
        chatId,
      });
      const { items } = await sessionEventService.listEvents(app.db, seed.agent.uuid, chatId, { limit: 10 });
      expect(items).toHaveLength(1);
      expect(items[0]?.kind).toBe("error");
    } finally {
      ws.close();
      await new Promise<void>((r) => ws.once("close", () => r()));
    }
  }, 15000);

  it("advances landing trial chat state once per confirmed turn completion id", async () => {
    const seed = await seedBoundAgent("landing-turn-end", "codex");
    const ws = await openBoundSocket(seed);
    const chatId = `chat-${crypto.randomUUID()}`;
    const notifySpy = vi.spyOn(app.notifier, "notifyChatUpdated").mockResolvedValue();

    async function sendTurnEnd(ref: string, turnCompletionId: string) {
      ws.send(
        JSON.stringify({
          type: "session:event",
          ref,
          agentId: seed.agent.uuid,
          chatId,
          event: { kind: "turn_end", payload: { status: "success", turnCompletionId } },
        }),
      );
      await waitForFrame(
        ws,
        (m) =>
          (m as { type?: string; ref?: string }).type === "session:event:accepted" &&
          (m as { ref?: string }).ref === ref,
      );
    }

    async function sendTokenUsage(
      ref: string,
      tokens: { inputTokens: number; cachedInputTokens: number; outputTokens: number },
    ) {
      ws.send(
        JSON.stringify({
          type: "session:event",
          ref,
          agentId: seed.agent.uuid,
          chatId,
          event: { kind: "token_usage", payload: { provider: "codex", model: "gpt-5", ...tokens } },
        }),
      );
      await waitForFrame(
        ws,
        (m) =>
          (m as { type?: string; ref?: string }).type === "session:event:accepted" &&
          (m as { ref?: string }).ref === ref,
      );
    }

    try {
      await app.db.insert(chats).values({
        id: chatId,
        organizationId: seed.organizationId,
        type: "group",
        metadata: buildLandingCampaignChatMetadata({
          campaign: "production-scan",
          agentId: seed.agent.uuid,
          skillSetId: "production-scan",
          skillSetVersion: "test",
          repo: {
            url: "https://github.com/acme/backend",
            owner: "acme",
            name: "backend",
            canonicalKey: "github.com/acme/backend",
          },
          state: "running",
          inputLocked: false,
          maxAgentTurns: 3,
          maxEstimatedTokens: 400,
          completedAgentTurns: 0,
        }),
      });

      ws.send(
        JSON.stringify({
          type: "session:event",
          agentId: seed.agent.uuid,
          chatId,
          event: { kind: "turn_end", payload: { status: "success", turnCompletionId: "inbox:unconfirmed" } },
        }),
      );
      await waitForCondition(async () => {
        const { items } = await sessionEventService.listEvents(app.db, seed.agent.uuid, chatId, { limit: 10 });
        return items.some((item) => item.kind === "turn_end") ? true : null;
      });
      const [unconfirmedChat] = await app.db
        .select({ metadata: chats.metadata })
        .from(chats)
        .where(eq(chats.id, chatId));
      expect(parseLandingCampaignTrialChatMetadata(unconfirmedChat?.metadata)).toMatchObject({
        state: "running",
        inputLocked: false,
        completedAgentTurns: 0,
        completedAgentTurnIds: [],
        estimatedTokensUsed: 0,
        lastObservedEstimatedTokens: 0,
      });

      await sendTokenUsage("landing-token-usage-1", {
        inputTokens: 100,
        cachedInputTokens: 10,
        outputTokens: 40,
      });
      await sendTurnEnd("landing-turn-end-1", "inbox:101");
      const [runningChat] = await app.db.select({ metadata: chats.metadata }).from(chats).where(eq(chats.id, chatId));
      expect(parseLandingCampaignTrialChatMetadata(runningChat?.metadata)).toMatchObject({
        state: "running",
        inputLocked: false,
        completedAgentTurns: 1,
        completedAgentTurnIds: ["inbox:101"],
        maxAgentTurns: 3,
        maxEstimatedTokens: 400,
        estimatedTokensUsed: 150,
        lastObservedEstimatedTokens: 150,
      });

      await sendTurnEnd("landing-turn-end-1-duplicate", "inbox:101");
      const [duplicateChat] = await app.db.select({ metadata: chats.metadata }).from(chats).where(eq(chats.id, chatId));
      expect(parseLandingCampaignTrialChatMetadata(duplicateChat?.metadata)).toMatchObject({
        state: "running",
        inputLocked: false,
        completedAgentTurns: 1,
        completedAgentTurnIds: ["inbox:101"],
        maxAgentTurns: 3,
        maxEstimatedTokens: 400,
        estimatedTokensUsed: 150,
        lastObservedEstimatedTokens: 150,
      });

      await sendTokenUsage("landing-token-usage-2", {
        inputTokens: 200,
        cachedInputTokens: 20,
        outputTokens: 80,
      });
      await sendTurnEnd("landing-turn-end-2", "inbox:102");
      const [completedChat] = await app.db.select({ metadata: chats.metadata }).from(chats).where(eq(chats.id, chatId));
      expect(parseLandingCampaignTrialChatMetadata(completedChat?.metadata)).toMatchObject({
        state: "completed",
        inputLocked: true,
        completedAgentTurns: 2,
        completedAgentTurnIds: ["inbox:101", "inbox:102"],
        maxAgentTurns: 3,
        maxEstimatedTokens: 400,
        estimatedTokensUsed: 450,
        lastObservedEstimatedTokens: 450,
        limitReason: "tokens",
      });
      expect(notifySpy).toHaveBeenCalledTimes(2);
      expect(notifySpy).toHaveBeenCalledWith(chatId);
    } finally {
      notifySpy.mockRestore();
      ws.close();
      await new Promise<void>((r) => ws.once("close", () => r()));
    }
  }, 15000);

  it("rejects a confirmed `session:event` when persistence fails", async () => {
    const seed = await seedBoundAgent("confirm-reject");
    const ws = await openBoundSocket(seed);
    const chatId = `chat-${crypto.randomUUID()}`;
    const ref = `event-${crypto.randomUUID()}`;
    const appendSpy = vi.spyOn(sessionEventService, "appendEvent").mockRejectedValueOnce(new Error("db down"));

    try {
      ws.send(
        JSON.stringify({
          type: "session:event",
          ref,
          agentId: seed.agent.uuid,
          chatId,
          event: {
            kind: "error",
            payload: { source: "runtime", message: "rejected failure" },
          },
        }),
      );

      const rejected = (await waitForFrame(
        ws,
        (m) =>
          (m as { type?: string; ref?: string }).type === "session:event:rejected" &&
          (m as { ref?: string }).ref === ref,
      )) as { type: string; ref: string; agentId: string; chatId: string; reason: string };

      expect(rejected).toMatchObject({
        type: "session:event:rejected",
        ref,
        agentId: seed.agent.uuid,
        chatId,
        reason: "persist_failed",
      });
    } finally {
      appendSpy.mockRestore();
      ws.close();
      await new Promise<void>((r) => ws.once("close", () => r()));
    }
  }, 15000);

  it("persists Context Tree IO derived from a `session:event` frame", async () => {
    const seed = await seedBoundAgent("context-io");
    const ws = await openBoundSocket(seed);
    const chatId = `chat-${crypto.randomUUID()}`;
    const treeRepoUrl = "https://github.com/acme/first-tree-context.git";

    try {
      await putOrgSetting(
        app.db,
        seed.organizationId,
        "context_tree",
        { repo: treeRepoUrl, branch: "main" },
        { updatedBy: seed.userId },
      );
      await app.db.insert(chats).values({ id: chatId, organizationId: seed.organizationId });

      ws.send(
        JSON.stringify({
          type: "session:event",
          agentId: seed.agent.uuid,
          chatId,
          event: {
            kind: "tool_call",
            payload: {
              toolUseId: "tu-context-write",
              name: "Write",
              args: {},
              status: "ok",
              toolFileRefs: [
                {
                  origin: "tool_arg",
                  repoUrl: treeRepoUrl,
                  repoBranch: "main",
                  repoRelativePath: "domains/runtime/NODE.md",
                  pathKind: "file",
                },
              ],
            },
          },
        }),
      );

      const ioRows = await waitForCondition(async () => {
        const rows = await app.db.select().from(contextTreeIoEvents).where(eq(contextTreeIoEvents.chatId, chatId));
        return rows.length > 0 ? rows : null;
      });
      const { items } = await sessionEventService.listEvents(app.db, seed.agent.uuid, chatId, { limit: 10 });

      expect(items).toHaveLength(1);
      expect(ioRows).toHaveLength(1);
      expect(ioRows[0]).toMatchObject({
        agentId: seed.agent.uuid,
        chatId,
        action: "write",
        source: "claude_write_tool",
        targetPath: "domains/runtime/NODE.md",
      });
    } finally {
      ws.close();
      await new Promise<void>((r) => ws.once("close", () => r()));
    }
  }, 15000);

  it("persists Context Tree IO from a Codex shell read `session:event` frame", async () => {
    const seed = await seedBoundAgent("context-shell-codex", "codex");
    const ws = await openBoundSocket(seed);
    const chatId = `chat-${crypto.randomUUID()}`;
    const treeRepoUrl = "https://github.com/acme/first-tree-context.git";

    try {
      await putOrgSetting(
        app.db,
        seed.organizationId,
        "context_tree",
        { repo: treeRepoUrl, branch: "main" },
        { updatedBy: seed.userId },
      );
      await app.db.insert(chats).values({ id: chatId, organizationId: seed.organizationId });

      ws.send(
        JSON.stringify({
          type: "session:event",
          agentId: seed.agent.uuid,
          chatId,
          event: {
            kind: "tool_call",
            payload: {
              toolUseId: "tu-codex-shell-read",
              name: "command",
              args: { command: "sed -n '1,120p' /tmp/context-tree/NODE.md", cwd: "/tmp/source" },
              status: "ok",
              toolFileRefs: [
                {
                  origin: "tool_arg",
                  repoUrl: treeRepoUrl,
                  repoBranch: "main",
                  repoRelativePath: "NODE.md",
                  pathKind: "file",
                },
              ],
            },
          },
        }),
      );

      const ioRows = await waitForCondition(async () => {
        const rows = await app.db.select().from(contextTreeIoEvents).where(eq(contextTreeIoEvents.chatId, chatId));
        return rows.length > 0 ? rows : null;
      });
      const { items } = await sessionEventService.listEvents(app.db, seed.agent.uuid, chatId, { limit: 10 });

      expect(items).toHaveLength(1);
      expect(ioRows).toHaveLength(1);
      expect(ioRows[0]).toMatchObject({
        agentId: seed.agent.uuid,
        chatId,
        runtimeProvider: "codex",
        action: "read",
        source: "shell_command",
        targetPath: "NODE.md",
      });
    } finally {
      ws.close();
      await new Promise<void>((r) => ws.once("close", () => r()));
    }
  }, 15000);

  it("keeps the session event when Context Tree IO recording fails", async () => {
    const seed = await seedBoundAgent("context-io-fail");
    const ws = await openBoundSocket(seed);
    const chatId = `chat-${crypto.randomUUID()}`;
    const treeRepoUrl = "https://github.com/acme/first-tree-context.git";
    const errorFrames: unknown[] = [];
    const ioSpy = vi
      .spyOn(contextTreeIoService, "recordFromSessionEvent")
      .mockRejectedValueOnce(new Error("context io failed"));

    ws.on("message", (raw) => {
      const parsed = JSON.parse(raw.toString()) as { type?: string };
      if (parsed.type === "error") errorFrames.push(parsed);
    });

    try {
      await putOrgSetting(
        app.db,
        seed.organizationId,
        "context_tree",
        { repo: treeRepoUrl, branch: "main" },
        { updatedBy: seed.userId },
      );
      await app.db.insert(chats).values({ id: chatId, organizationId: seed.organizationId });

      ws.send(
        JSON.stringify({
          type: "session:event",
          agentId: seed.agent.uuid,
          chatId,
          event: {
            kind: "tool_call",
            payload: {
              toolUseId: "tu-context-write-fail",
              name: "Write",
              args: {},
              status: "ok",
              toolFileRefs: [
                {
                  origin: "tool_arg",
                  repoUrl: treeRepoUrl,
                  repoBranch: "main",
                  repoRelativePath: "domains/runtime/NODE.md",
                  pathKind: "file",
                },
              ],
            },
          },
        }),
      );

      const { items } = await waitForCondition(async () => {
        const listed = await sessionEventService.listEvents(app.db, seed.agent.uuid, chatId, { limit: 10 });
        return listed.items.length > 0 ? listed : null;
      });
      await waitForCondition(async () => (ioSpy.mock.calls.length > 0 ? true : null));

      const ioRows = await app.db.select().from(contextTreeIoEvents).where(eq(contextTreeIoEvents.chatId, chatId));
      expect(items).toHaveLength(1);
      expect(errorFrames).toHaveLength(0);
      expect(ioRows).toHaveLength(0);

      ioSpy.mockRestore();
      const summary = await contextTreeIoService.summarizeContextTreeIo(app.db, seed.organizationId, 7);
      const replayedRows = await app.db
        .select()
        .from(contextTreeIoEvents)
        .where(eq(contextTreeIoEvents.chatId, chatId));
      expect(summary.summary.write.eventCount).toBeGreaterThanOrEqual(1);
      expect(replayedRows).toHaveLength(1);
      expect(replayedRows[0]).toMatchObject({
        action: "write",
        source: "claude_write_tool",
        targetPath: "domains/runtime/NODE.md",
      });
    } finally {
      ioSpy.mockRestore();
      ws.close();
      await new Promise<void>((r) => ws.once("close", () => r()));
    }
  }, 15000);

  it("rejects an `evicted` session:state frame from a stale client and preserves events", async () => {
    const seed = await seedBoundAgent("evict");
    const ws = await openBoundSocket(seed);
    const chatId = `chat-${crypto.randomUUID()}`;

    try {
      await sessionEventService.appendEvent(app.db, seed.agent.uuid, chatId, {
        kind: "error",
        payload: { source: "sdk", message: "before stale evicted frame" },
      });
      await sessionEventService.appendEvent(app.db, seed.agent.uuid, chatId, {
        kind: "tool_call",
        payload: { toolUseId: "t1", name: "Read", args: {}, status: "ok" },
      });

      const errorMessages: string[] = [];
      ws.on("message", (raw) => {
        try {
          const parsed = JSON.parse(raw.toString()) as { type?: string; message?: string };
          if (parsed.type === "error" && parsed.message) errorMessages.push(parsed.message);
        } catch {
          // ignore
        }
      });

      ws.send(
        JSON.stringify({
          type: "session:state",
          agentId: seed.agent.uuid,
          chatId,
          state: "evicted",
        }),
      );

      await waitForCondition(async () => {
        return errorMessages.some((m) => m.includes("Unsupported session state")) ? true : null;
      });

      // Events were NOT cleared — the stale frame produces an error, not a side effect.
      const { items } = await sessionEventService.listEvents(app.db, seed.agent.uuid, chatId, { limit: 10 });
      expect(items).toHaveLength(2);
    } finally {
      ws.close();
      await new Promise<void>((r) => ws.once("close", () => r()));
    }
  }, 15000);

  it("keeps events when `session:state` moves to 'suspended'", async () => {
    const seed = await seedBoundAgent("suspend");
    const ws = await openBoundSocket(seed);
    const chatId = `chat-${crypto.randomUUID()}`;

    try {
      await sessionEventService.appendEvent(app.db, seed.agent.uuid, chatId, {
        kind: "tool_call",
        payload: { toolUseId: "t1", name: "Read", args: {}, status: "ok" },
      });

      ws.send(
        JSON.stringify({
          type: "session:state",
          agentId: seed.agent.uuid,
          chatId,
          state: "suspended",
        }),
      );

      // Wait a beat for any (incorrect) cleanup to fire, then assert row is still there.
      await new Promise((r) => setTimeout(r, 300));
      const { items } = await sessionEventService.listEvents(app.db, seed.agent.uuid, chatId, { limit: 10 });
      expect(items).toHaveLength(1);
    } finally {
      ws.close();
      await new Promise<void>((r) => ws.once("close", () => r()));
    }
  }, 15000);

  it("rejected `evicted` frame following session:event does not disturb persisted events", async () => {
    const seed = await seedBoundAgent("race");
    const ws = await openBoundSocket(seed);
    const chatId = `chat-${crypto.randomUUID()}`;

    try {
      const eventCount = 5;
      for (let i = 0; i < eventCount; i += 1) {
        ws.send(
          JSON.stringify({
            type: "session:event",
            agentId: seed.agent.uuid,
            chatId,
            event: {
              kind: "tool_call",
              payload: { toolUseId: `tu-${i}`, name: "Bash", args: { i }, status: "ok", durationMs: 1 },
            },
          }),
        );
      }
      ws.send(
        JSON.stringify({
          type: "session:state",
          agentId: seed.agent.uuid,
          chatId,
          state: "evicted",
        }),
      );

      // Give the server time to persist the events and reject the stale frame.
      await new Promise((r) => setTimeout(r, 800));

      const { items } = await sessionEventService.listEvents(app.db, seed.agent.uuid, chatId, { limit: 50 });
      expect(items).toHaveLength(eventCount);
    } finally {
      ws.close();
      await new Promise<void>((r) => ws.once("close", () => r()));
    }
  }, 15000);

  it("`session:reconcile` returns staleChatIds for evicted or missing rows", async () => {
    const seed = await seedBoundAgent("recon");
    const ws = await openBoundSocket(seed);

    try {
      const { agentChatSessions: table } = await import("../db/schema/agent-chat-sessions.js");
      const { chats: chatsTable } = await import("../db/schema/chats.js");

      const activeId = `chat-active-${crypto.randomUUID()}`;
      const suspendedId = `chat-suspended-${crypto.randomUUID()}`;
      const evictedId = `chat-evicted-${crypto.randomUUID()}`;
      const missingId = `chat-missing-${crypto.randomUUID()}`;

      await app.db
        .insert(chatsTable)
        .values([
          { id: activeId, organizationId: seed.organizationId },
          { id: suspendedId, organizationId: seed.organizationId },
          { id: evictedId, organizationId: seed.organizationId },
        ])
        .onConflictDoNothing();
      await app.db
        .insert(table)
        .values([
          { agentId: seed.agent.uuid, chatId: activeId, state: "active" },
          { agentId: seed.agent.uuid, chatId: suspendedId, state: "suspended" },
          { agentId: seed.agent.uuid, chatId: evictedId, state: "evicted" },
        ])
        .onConflictDoNothing();

      ws.send(
        JSON.stringify({
          type: "session:reconcile",
          agentId: seed.agent.uuid,
          chatIds: [activeId, suspendedId, evictedId, missingId],
        }),
      );

      const result = (await waitForFrame(ws, (m) => (m as { type?: string }).type === "session:reconcile:result")) as {
        staleChatIds: string[];
        agentId: string;
      };

      expect(result.agentId).toBe(seed.agent.uuid);
      expect(new Set(result.staleChatIds)).toEqual(new Set([evictedId, missingId]));
    } finally {
      ws.close();
      await new Promise<void>((r) => ws.once("close", () => r()));
    }
  }, 15000);
});
