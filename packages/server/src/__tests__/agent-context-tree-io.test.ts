import { describe, expect, it } from "vitest";
import { chats } from "../db/schema/chats.js";
import { contextTreeIoEvents } from "../db/schema/context-tree-io-events.js";
import { listAgentContextTreeIoEvents } from "../services/context-tree-io.js";
import { createTestAgent, useTestApp } from "./helpers.js";

const TREE_REPO = "https://github.com/acme/first-tree-context.git";
const getApp = useTestApp();

type SeededEvent = {
  chatId: string;
  action: "read" | "write";
  targetPath: string;
  createdAt: Date;
  headCommit?: string;
};

async function seedAgentWithEvents(events: SeededEvent[]) {
  const app = getApp();
  const seed = await createTestAgent(app);
  const chatIds = [...new Set(events.map((event) => event.chatId))];
  for (const chatId of chatIds) {
    await app.db.insert(chats).values({ id: chatId, organizationId: seed.organizationId, type: "direct", topic: "io" });
  }
  let index = 0;
  for (const event of events) {
    index += 1;
    await app.db.insert(contextTreeIoEvents).values({
      id: `io-${seed.agent.uuid}-${index}`,
      organizationId: seed.organizationId,
      agentId: seed.agent.uuid,
      chatId: event.chatId,
      sourceSessionEventId: `se-${seed.agent.uuid}-${index}`,
      sourceIndex: 0,
      runtimeProvider: "claude-code",
      action: event.action,
      source: event.action === "read" ? "claude_read_tool" : "claude_write_tool",
      treeRepoUrl: TREE_REPO,
      treeBranch: "main",
      targetKind: "file",
      targetPath: event.targetPath,
      metadata: event.headCommit ? { repoHeadCommit: event.headCommit } : {},
      createdAt: event.createdAt,
    });
  }
  return seed;
}

const at = (iso: string) => new Date(iso);

describe("agent-scoped Context Tree IO feed", () => {
  it("returns only the calling agent's own events, newest first", async () => {
    const app = getApp();
    const chatId = `chat-${crypto.randomUUID()}`;
    const seed = await seedAgentWithEvents([
      { chatId, action: "read", targetPath: "system/a.md", createdAt: at("2026-07-01T10:00:00Z") },
      { chatId, action: "read", targetPath: "system/b.md", createdAt: at("2026-07-01T12:00:00Z") },
    ]);
    // A second agent's events must never leak into the first agent's feed.
    const other = await seedAgentWithEvents([
      {
        chatId: `chat-${crypto.randomUUID()}`,
        action: "read",
        targetPath: "other/x.md",
        createdAt: at("2026-07-01T11:00:00Z"),
      },
    ]);
    expect(other.agent.uuid).not.toBe(seed.agent.uuid);

    const result = await listAgentContextTreeIoEvents(app.db, {
      organizationId: seed.organizationId,
      agentId: seed.agent.uuid,
      limit: 50,
    });

    expect(result.items.map((item) => item.targetPath)).toEqual(["system/b.md", "system/a.md"]);
    expect(result.nextCursor).toBeNull();
  });

  it("filters by chat, action, and time window", async () => {
    const app = getApp();
    const chatA = `chat-${crypto.randomUUID()}`;
    const chatB = `chat-${crypto.randomUUID()}`;
    const seed = await seedAgentWithEvents([
      { chatId: chatA, action: "read", targetPath: "a/early.md", createdAt: at("2026-07-01T00:00:00Z") },
      { chatId: chatA, action: "read", targetPath: "a/mid.md", createdAt: at("2026-07-05T00:00:00Z") },
      { chatId: chatA, action: "write", targetPath: "a/written.md", createdAt: at("2026-07-05T01:00:00Z") },
      { chatId: chatB, action: "read", targetPath: "b/other.md", createdAt: at("2026-07-05T02:00:00Z") },
    ]);
    const base = { organizationId: seed.organizationId, agentId: seed.agent.uuid, limit: 50 };

    const byChat = await listAgentContextTreeIoEvents(app.db, { ...base, chatId: chatA });
    expect(byChat.items).toHaveLength(3);

    const readsOnly = await listAgentContextTreeIoEvents(app.db, { ...base, chatId: chatA, action: "read" });
    expect(readsOnly.items.map((item) => item.targetPath)).toEqual(["a/mid.md", "a/early.md"]);

    const windowed = await listAgentContextTreeIoEvents(app.db, {
      ...base,
      since: at("2026-07-02T00:00:00Z"),
      until: at("2026-07-05T01:30:00Z"),
    });
    expect(windowed.items.map((item) => item.targetPath)).toEqual(["a/written.md", "a/mid.md"]);
  });

  it("paginates without dropping or repeating a row", async () => {
    const app = getApp();
    const chatId = `chat-${crypto.randomUUID()}`;
    const seed = await seedAgentWithEvents(
      Array.from({ length: 5 }, (_, index) => ({
        chatId,
        action: "read" as const,
        targetPath: `n/${index}.md`,
        createdAt: at(`2026-07-0${index + 1}T00:00:00Z`),
      })),
    );
    const base = { organizationId: seed.organizationId, agentId: seed.agent.uuid };

    const first = await listAgentContextTreeIoEvents(app.db, { ...base, limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await listAgentContextTreeIoEvents(app.db, {
      ...base,
      limit: 10,
      cursor: first.nextCursor ?? undefined,
    });
    const seen = [...first.items, ...second.items].map((item) => item.targetPath);
    expect(seen).toEqual(["n/4.md", "n/3.md", "n/2.md", "n/1.md", "n/0.md"]);
    expect(new Set(seen).size).toBe(5);
    expect(second.nextCursor).toBeNull();
  });

  it("surfaces the observed head commit only when it is a valid sha", async () => {
    const app = getApp();
    const chatId = `chat-${crypto.randomUUID()}`;
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const seed = await seedAgentWithEvents([
      { chatId, action: "read", targetPath: "with.md", createdAt: at("2026-07-02T00:00:00Z"), headCommit: commit },
      { chatId, action: "read", targetPath: "without.md", createdAt: at("2026-07-01T00:00:00Z") },
      { chatId, action: "read", targetPath: "bogus.md", createdAt: at("2026-06-30T00:00:00Z"), headCommit: "nope" },
    ]);

    const result = await listAgentContextTreeIoEvents(app.db, {
      organizationId: seed.organizationId,
      agentId: seed.agent.uuid,
      limit: 50,
    });
    expect(result.items.map((item) => [item.targetPath, item.treeHeadCommit])).toEqual([
      ["with.md", commit],
      ["without.md", null],
      ["bogus.md", null],
    ]);
  });

  it("rejects a malformed cursor instead of silently returning page one", async () => {
    const app = getApp();
    const seed = await createTestAgent(app);
    await expect(
      listAgentContextTreeIoEvents(app.db, {
        organizationId: seed.organizationId,
        agentId: seed.agent.uuid,
        limit: 10,
        cursor: "not-a-cursor",
      }),
    ).rejects.toThrow(/Invalid Context Tree IO cursor/);
  });

  it("serves the agent route and rejects an inverted time window", async () => {
    const app = getApp();
    const chatId = `chat-${crypto.randomUUID()}`;
    const seed = await seedAgentWithEvents([
      { chatId, action: "read", targetPath: "route/a.md", createdAt: at("2026-07-01T10:00:00Z") },
    ]);

    const ok = await app.inject({
      method: "GET",
      url: "/api/v1/agent/context-tree/io?limit=10",
      headers: { authorization: `Bearer ${seed.accessToken}`, "x-agent-id": seed.agent.uuid },
    });
    expect(ok.statusCode).toBe(200);
    const body = ok.json() as { items: Array<{ targetPath: string }>; nextCursor: string | null };
    expect(body.items.map((item) => item.targetPath)).toEqual(["route/a.md"]);
    expect(body.nextCursor).toBeNull();

    const inverted = await app.inject({
      method: "GET",
      url: "/api/v1/agent/context-tree/io?since=2026-07-05T00:00:00Z&until=2026-07-01T00:00:00Z",
      headers: { authorization: `Bearer ${seed.accessToken}`, "x-agent-id": seed.agent.uuid },
    });
    expect(inverted.statusCode).toBe(400);
  });

  it("requires agent authentication", async () => {
    const app = getApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/agent/context-tree/io" });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});
