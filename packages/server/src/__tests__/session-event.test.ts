import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { chats } from "../db/schema/chats.js";
import { organizations } from "../db/schema/organizations.js";
import { sessionEvents } from "../db/schema/session-events.js";
import * as sessionEventService from "../services/session-event.js";
import { uuidv7 } from "../uuid.js";
import { createTestAgent, useTestApp } from "./helpers.js";

/**
 * S10 (NC2 backend) — session_events persistence & seq semantics.
 *
 * The service guarantees per-(agent, chat) monotonic `seq` via a
 * single-statement MAX(seq)+1 + ON CONFLICT DO NOTHING with a bounded
 * retry loop. These tests lock the guarantee down and exercise the
 * admin read path (listEvents cursor pagination) and the eviction
 * cleanup path (clearEvents).
 */
describe("sessionEventService", () => {
  const getApp = useTestApp();
  const agentId = () => `agent-${crypto.randomUUID()}`;
  const chatId = () => `chat-${crypto.randomUUID()}`;

  it("assigns seq 1, 2, 3 for three sequential appends", async () => {
    const app = getApp();
    const a = agentId();
    const c = chatId();

    const r1 = await sessionEventService.appendEvent(app.db, a, c, {
      kind: "tool_call",
      payload: { toolUseId: "tu1", name: "Bash", args: {}, status: "ok", durationMs: 10 },
    });
    const r2 = await sessionEventService.appendEvent(app.db, a, c, {
      kind: "tool_call",
      payload: { toolUseId: "tu2", name: "Read", args: {}, status: "ok", durationMs: 20 },
    });
    const r3 = await sessionEventService.appendEvent(app.db, a, c, {
      kind: "error",
      payload: { source: "sdk", message: "boom" },
    });

    expect(r1.seq).toBe(1);
    expect(r2.seq).toBe(2);
    expect(r3.seq).toBe(3);
    expect(r1.kind).toBe("tool_call");
    expect(r3.kind).toBe("error");
  });

  it("isolates seq per (agent, chat) pair", async () => {
    const app = getApp();
    const a = agentId();
    const c1 = chatId();
    const c2 = chatId();

    const r1 = await sessionEventService.appendEvent(app.db, a, c1, {
      kind: "tool_call",
      payload: { toolUseId: "x", name: "Bash", args: {}, status: "ok" },
    });
    const r2 = await sessionEventService.appendEvent(app.db, a, c2, {
      kind: "tool_call",
      payload: { toolUseId: "y", name: "Bash", args: {}, status: "ok" },
    });
    const r3 = await sessionEventService.appendEvent(app.db, a, c1, {
      kind: "tool_call",
      payload: { toolUseId: "z", name: "Bash", args: {}, status: "ok" },
    });

    expect(r1.seq).toBe(1);
    expect(r2.seq).toBe(1);
    expect(r3.seq).toBe(2);
  });

  it("resolves contention via ON CONFLICT + retry", async () => {
    const app = getApp();
    const a = agentId();
    const c = chatId();

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        sessionEventService.appendEvent(app.db, a, c, {
          kind: "tool_call",
          payload: { toolUseId: `tu${i}`, name: "Bash", args: {}, status: "ok" },
        }),
      ),
    );

    const seqs = results.map((r) => r.seq).sort((x, y) => x - y);
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(seqs).size).toBe(5);
  });

  it("rejects invalid payload shapes before insert", async () => {
    const app = getApp();
    const a = agentId();
    const c = chatId();

    await expect(
      sessionEventService.appendEvent(app.db, a, c, {
        kind: "tool_call",
        // missing `name`
        payload: { toolUseId: "tu1", args: {}, status: "ok" } as unknown as {
          toolUseId: string;
          name: string;
          args: unknown;
          status: "ok" | "error" | "pending";
        },
      }),
    ).rejects.toThrow();
  });

  it("listEvents paginates by seq asc", async () => {
    const app = getApp();
    const a = agentId();
    const c = chatId();

    for (let i = 0; i < 5; i++) {
      await sessionEventService.appendEvent(app.db, a, c, {
        kind: "tool_call",
        payload: { toolUseId: `tu${i}`, name: "Bash", args: {}, status: "ok" },
      });
    }

    const page1 = await sessionEventService.listEvents(app.db, a, c, { limit: 2 });
    expect(page1.items.map((x) => x.seq)).toEqual([1, 2]);
    expect(page1.nextCursor).toBe(2);
    if (page1.nextCursor === null) throw new Error("expected cursor");

    const page2 = await sessionEventService.listEvents(app.db, a, c, { limit: 2, cursor: page1.nextCursor });
    expect(page2.items.map((x) => x.seq)).toEqual([3, 4]);
    expect(page2.nextCursor).toBe(4);
    if (page2.nextCursor === null) throw new Error("expected cursor");

    const page3 = await sessionEventService.listEvents(app.db, a, c, { limit: 2, cursor: page2.nextCursor });
    expect(page3.items.map((x) => x.seq)).toEqual([5]);
    expect(page3.nextCursor).toBeNull();
  });

  it("listEvents returns newest-first when direction=desc and paginates by seq<cursor", async () => {
    // Chat-view relies on this to always see the latest turn_end even when
    // the chat has more events than a single page can hold.
    const app = getApp();
    const a = agentId();
    const c = chatId();

    for (let i = 0; i < 5; i++) {
      await sessionEventService.appendEvent(app.db, a, c, {
        kind: "tool_call",
        payload: { toolUseId: `tu${i}`, name: "Bash", args: {}, status: "ok" },
      });
    }

    const page1 = await sessionEventService.listEvents(app.db, a, c, { limit: 2, direction: "desc" });
    expect(page1.items.map((x) => x.seq)).toEqual([5, 4]);
    expect(page1.nextCursor).toBe(4);
    if (page1.nextCursor === null) throw new Error("expected cursor");

    const page2 = await sessionEventService.listEvents(app.db, a, c, {
      limit: 2,
      cursor: page1.nextCursor,
      direction: "desc",
    });
    expect(page2.items.map((x) => x.seq)).toEqual([3, 2]);
    expect(page2.nextCursor).toBe(2);
    if (page2.nextCursor === null) throw new Error("expected cursor");

    const page3 = await sessionEventService.listEvents(app.db, a, c, {
      limit: 2,
      cursor: page2.nextCursor,
      direction: "desc",
    });
    expect(page3.items.map((x) => x.seq)).toEqual([1]);
    expect(page3.nextCursor).toBeNull();
  });

  it("listEvents with direction=desc returns the latest turn_end even with >limit events", async () => {
    // Regression guard for the chat-view's turn-grouping filter: when there
    // are more events than a single page, fetching desc must include the
    // most recent turn_end, not stale prefix events.
    const app = getApp();
    const a = agentId();
    const c = chatId();

    // Seed 10 tool_calls, then a turn_end at seq=11.
    for (let i = 0; i < 10; i++) {
      await sessionEventService.appendEvent(app.db, a, c, {
        kind: "tool_call",
        payload: { toolUseId: `tu${i}`, name: "Bash", args: {}, status: "ok" },
      });
    }
    await sessionEventService.appendEvent(app.db, a, c, {
      kind: "turn_end",
      payload: { status: "success" },
    });

    // Pretend the UI only fetches 3 rows — desc must still surface turn_end.
    const page = await sessionEventService.listEvents(app.db, a, c, { limit: 3, direction: "desc" });
    expect(page.items[0]?.kind).toBe("turn_end");
    expect(page.items[0]?.seq).toBe(11);
  });

  it("clearEvents empties the (agent, chat) rows and leaves siblings untouched", async () => {
    const app = getApp();
    const a = agentId();
    const c1 = chatId();
    const c2 = chatId();

    await sessionEventService.appendEvent(app.db, a, c1, {
      kind: "error",
      payload: { source: "sdk", message: "x" },
    });
    await sessionEventService.appendEvent(app.db, a, c2, {
      kind: "error",
      payload: { source: "sdk", message: "y" },
    });

    await sessionEventService.clearEvents(app.db, a, c1);

    const remaining1 = await app.db
      .select()
      .from(sessionEvents)
      .where(and(eq(sessionEvents.agentId, a), eq(sessionEvents.chatId, c1)));
    const remaining2 = await app.db
      .select()
      .from(sessionEvents)
      .where(and(eq(sessionEvents.agentId, a), eq(sessionEvents.chatId, c2)));

    expect(remaining1).toHaveLength(0);
    expect(remaining2).toHaveLength(1);
  });

  it("summarizes Context Tree usage with org-wide visibility — every in-org chat exposes its topic", async () => {
    const app = getApp();
    const { agent, organizationId } = await createTestAgent(app);
    const c = chatId();

    // No chat_membership row for the caller — under the new org-wide
    // visibility model the chat is still exposed because it belongs to
    // the same org as the caller. Chat *content* is gated separately by
    // requireChatAccess on the chat-detail route; this feed only shares
    // the topic label so admins can see what work used the tree.
    await app.db.insert(chats).values({ id: c, organizationId, type: "direct", topic: "design-spike" });

    await sessionEventService.appendEvent(app.db, agent.uuid, c, {
      kind: "context_tree_usage",
      payload: {
        purpose: "design_decision",
        treeRepoUrl: "https://github.com/example/tree",
        nodePath: "members/Gandy2025/NODE.md",
      },
    });
    await sessionEventService.appendEvent(app.db, agent.uuid, c, {
      kind: "context_tree_usage",
      payload: {
        purpose: "design_decision",
        treeRepoUrl: "https://github.com/example/tree",
        nodePath: "designs/context-tree-usage-signal.md",
      },
    });
    await sessionEventService.appendEvent(app.db, agent.uuid, c, {
      kind: "tool_call",
      payload: { toolUseId: "tu", name: "Read", args: {}, status: "ok" },
    });
    await sessionEventService.appendEvent(app.db, "missing-agent", c, {
      kind: "context_tree_usage",
      payload: { purpose: "design_decision", treeRepoUrl: null, nodePath: null },
    });

    const summary = await sessionEventService.summarizeContextTreeUsage(app.db, organizationId, 3);
    expect(summary.windowDays).toBe(3);
    expect(summary.agentCount).toBe(1);
    expect(summary.usageCount).toBe(2);
    expect(summary.recentEvents).toHaveLength(2);
    for (const event of summary.recentEvents) {
      expect(event.agentId).toBe(agent.uuid);
      expect(event.agentName).toBe(agent.displayName);
      expect(event.chatId).toBe(c);
      expect(event.chatTitle).toBe("design-spike");
      expect(typeof event.createdAt).toBe("string");
    }
    expect(new Date(summary.recentEvents[0]?.createdAt ?? 0).getTime()).toBeGreaterThanOrEqual(
      new Date(summary.recentEvents[1]?.createdAt ?? 0).getTime(),
    );
    // nodePath is surfaced from the stored payload, newest-first.
    expect(summary.recentEvents[0]?.nodePath).toBe("designs/context-tree-usage-signal.md");
    expect(summary.recentEvents[1]?.nodePath).toBe("members/Gandy2025/NODE.md");
  });

  it("exposes the agent's avatar color token in the feed so the web client renders the same disc as elsewhere", async () => {
    const app = getApp();
    const { agent, organizationId } = await createTestAgent(app);
    // Manager-set color token on the agent — the feed must surface it
    // unchanged so the web client can render `var(--avatar-hue-3)`.
    await app.db.update(agents).set({ avatarColorToken: "hue-3" }).where(eq(agents.uuid, agent.uuid));

    const c = chatId();
    await app.db.insert(chats).values({ id: c, organizationId, type: "direct", topic: "design-spike" });
    await sessionEventService.appendEvent(app.db, agent.uuid, c, {
      kind: "context_tree_usage",
      payload: { purpose: "design_decision", treeRepoUrl: null, nodePath: "NODE.md" },
    });

    const summary = await sessionEventService.summarizeContextTreeUsage(app.db, organizationId, 3);
    const event = summary.recentEvents[0];
    expect(event?.agentAvatarColorToken).toBe("hue-3");
  });

  it("returns null avatarColorToken when the agent has no manager-set color (web falls back to deterministic hash)", async () => {
    const app = getApp();
    const { agent, organizationId } = await createTestAgent(app);
    // createTestAgent leaves avatar_color_token unset → NULL.
    const c = chatId();
    await app.db.insert(chats).values({ id: c, organizationId, type: "direct", topic: "design-spike" });
    await sessionEventService.appendEvent(app.db, agent.uuid, c, {
      kind: "context_tree_usage",
      payload: { purpose: "design_decision", treeRepoUrl: null, nodePath: "NODE.md" },
    });

    const summary = await sessionEventService.summarizeContextTreeUsage(app.db, organizationId, 3);
    expect(summary.recentEvents[0]?.agentAvatarColorToken).toBeNull();
  });

  it("masks chatId for a cross-org chat — events whose chat_id points outside the org never expose the topic", async () => {
    const app = getApp();
    const { agent, organizationId } = await createTestAgent(app);

    // Plant a chat in another org and have an orgA agent emit a
    // context_tree_usage event whose chat_id points at it. session_events
    // has no FK so this kind of stale / forged row is reachable in practice.
    // The org-wide visibility rule still must NOT expose orgB's topic to
    // an orgA caller — the left-join on chats AND chats.organization_id = $orgA
    // misses, joinedChatId is null, both chatId/chatTitle mask to null.
    const orgB = uuidv7();
    await app.db.insert(organizations).values({
      id: orgB,
      name: `org-b-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "Org B",
    });
    const crossOrgChatId = chatId();
    await app.db
      .insert(chats)
      .values({ id: crossOrgChatId, organizationId: orgB, type: "direct", topic: "leaked-topic" });

    await sessionEventService.appendEvent(app.db, agent.uuid, crossOrgChatId, {
      kind: "context_tree_usage",
      payload: { purpose: "design_decision", treeRepoUrl: null, nodePath: "NODE.md" },
    });

    const summary = await sessionEventService.summarizeContextTreeUsage(app.db, organizationId, 3);
    expect(summary.recentEvents).toHaveLength(1);
    const event = summary.recentEvents[0];
    expect(event?.chatId).toBeNull();
    expect(event?.chatTitle).toBeNull();
  });

  it("keeps a non-null chatId when the in-org chat has no topic set (chatTitle null is the legitimate 'no topic' signal)", async () => {
    const app = getApp();
    const { agent, organizationId } = await createTestAgent(app);
    const c = chatId();
    // chats.topic is nullable — admin never set one. Differentiating this
    // from a cross-org miss matters: in-org but no topic → chatId present,
    // chatTitle null. cross-org miss → both null.
    await app.db.insert(chats).values({ id: c, organizationId, type: "direct" });

    await sessionEventService.appendEvent(app.db, agent.uuid, c, {
      kind: "context_tree_usage",
      payload: { purpose: "design_decision", treeRepoUrl: null, nodePath: "NODE.md" },
    });

    const summary = await sessionEventService.summarizeContextTreeUsage(app.db, organizationId, 3);
    const event = summary.recentEvents[0];
    expect(event?.chatId).toBe(c);
    expect(event?.chatTitle).toBeNull();
  });

  it("surfaces nodePath null for a pre-P0 event whose payload predates the field", async () => {
    const app = getApp();
    const { agent, organizationId } = await createTestAgent(app);
    const c = chatId();
    await app.db.insert(chats).values({ id: c, organizationId, type: "direct", topic: "legacy" });

    // Simulate a row written before the nodePath field existed — insert the
    // legacy payload shape directly (appendEvent now requires nodePath, so it
    // can't reproduce this). The feed must degrade to nodePath: null rather
    // than throw at the snapshot-schema parse boundary.
    await app.db.insert(sessionEvents).values({
      id: uuidv7(),
      agentId: agent.uuid,
      chatId: c,
      seq: 1,
      kind: "context_tree_usage",
      payload: { purpose: "design_decision", treeRepoUrl: null },
    });

    const summary = await sessionEventService.summarizeContextTreeUsage(app.db, organizationId, 3);
    expect(summary.recentEvents).toHaveLength(1);
    expect(summary.recentEvents[0]?.nodePath).toBeNull();
  });
});
