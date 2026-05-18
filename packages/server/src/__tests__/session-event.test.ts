import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { members } from "../db/schema/members.js";
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

  it("summarizes Context Tree usage by organization, masking chat for non-members", async () => {
    const app = getApp();
    const { agent, memberId, organizationId } = await createTestAgent(app);
    const [adminMember] = await app.db.select().from(members).where(eq(members.id, memberId)).limit(1);
    if (!adminMember) throw new Error("admin member missing");
    const humanAgentId = adminMember.agentId;
    const c = chatId();

    await sessionEventService.appendEvent(app.db, agent.uuid, c, {
      kind: "context_tree_usage",
      payload: { purpose: "design_decision", treeRepoUrl: "https://github.com/example/tree" },
    });
    await sessionEventService.appendEvent(app.db, agent.uuid, c, {
      kind: "context_tree_usage",
      payload: { purpose: "design_decision", treeRepoUrl: "https://github.com/example/tree" },
    });
    await sessionEventService.appendEvent(app.db, agent.uuid, c, {
      kind: "tool_call",
      payload: { toolUseId: "tu", name: "Read", args: {}, status: "ok" },
    });
    await sessionEventService.appendEvent(app.db, "missing-agent", c, {
      kind: "context_tree_usage",
      payload: { purpose: "design_decision", treeRepoUrl: null },
    });

    const summary = await sessionEventService.summarizeContextTreeUsage(app.db, organizationId, 3, {
      humanAgentId,
      memberId,
    });
    expect(summary.windowDays).toBe(3);
    expect(summary.agentCount).toBe(1);
    expect(summary.usageCount).toBe(2);
    expect(summary.recentEvents).toHaveLength(2);
    for (const event of summary.recentEvents) {
      expect(event.agentId).toBe(agent.uuid);
      expect(event.agentName).toBe(agent.displayName);
      // Chat has no chat_membership row for this caller and no managed
      // speaker either → both chat fields must be masked.
      expect(event.chatId).toBeNull();
      expect(event.chatTitle).toBeNull();
      expect(typeof event.createdAt).toBe("string");
    }
    expect(new Date(summary.recentEvents[0]?.createdAt ?? 0).getTime()).toBeGreaterThanOrEqual(
      new Date(summary.recentEvents[1]?.createdAt ?? 0).getTime(),
    );
  });

  it("exposes chatId/chatTitle when the viewer is a direct member of the chat", async () => {
    const app = getApp();
    const { agent, memberId, organizationId } = await createTestAgent(app);
    const [adminMember] = await app.db.select().from(members).where(eq(members.id, memberId)).limit(1);
    if (!adminMember) throw new Error("admin member missing");
    const humanAgentId = adminMember.agentId;
    const c = chatId();

    await app.db.insert(chats).values({ id: c, organizationId, type: "direct", topic: "design-spike" });
    await app.db
      .insert(chatMembership)
      .values({ chatId: c, agentId: humanAgentId, role: "member", accessMode: "watcher" });

    await sessionEventService.appendEvent(app.db, agent.uuid, c, {
      kind: "context_tree_usage",
      payload: { purpose: "design_decision", treeRepoUrl: null },
    });

    const summary = await sessionEventService.summarizeContextTreeUsage(app.db, organizationId, 3, {
      humanAgentId,
      memberId,
    });
    expect(summary.recentEvents).toHaveLength(1);
    const event = summary.recentEvents[0];
    expect(event?.chatId).toBe(c);
    expect(event?.chatTitle).toBe("design-spike");
  });

  it("exposes chatId/chatTitle when a speaker in the chat is supervised by the viewer", async () => {
    const app = getApp();
    const { agent, memberId, organizationId } = await createTestAgent(app);
    const c = chatId();

    await app.db.insert(chats).values({ id: c, organizationId, type: "direct", topic: "qa-run-42" });
    // The viewer's human agent is NOT in chat_membership, but the supervised
    // agent (created by createTestAgent with managerId=adminMember) is a
    // speaker — the supervisor branch of requireChatAccess should pass.
    await app.db
      .insert(chatMembership)
      .values({ chatId: c, agentId: agent.uuid, role: "member", accessMode: "speaker" });

    await sessionEventService.appendEvent(app.db, agent.uuid, c, {
      kind: "context_tree_usage",
      payload: { purpose: "design_decision", treeRepoUrl: null },
    });

    // viewer's humanAgentId intentionally NOT in chat_membership — only the
    // supervised-speaker branch can grant visibility here.
    const summary = await sessionEventService.summarizeContextTreeUsage(app.db, organizationId, 3, {
      humanAgentId: null,
      memberId,
    });
    expect(summary.recentEvents).toHaveLength(1);
    const event = summary.recentEvents[0];
    expect(event?.chatId).toBe(c);
    expect(event?.chatTitle).toBe("qa-run-42");
  });

  it("masks chatId for a cross-org chat even when a stale chat_membership row would otherwise grant access", async () => {
    const app = getApp();
    const { agent, memberId, organizationId } = await createTestAgent(app);
    const [adminMember] = await app.db.select().from(members).where(eq(members.id, memberId)).limit(1);
    if (!adminMember) throw new Error("admin member missing");
    const humanAgentId = adminMember.agentId;

    // Set up a second org with its own chat — the viewer has no legitimate
    // access to anything inside it. Then plant a dirty cross-org
    // chat_membership row (chat lives in orgB, but agent_id is the viewer's
    // humanAgent from orgA). Without the org anchor on the visibility query
    // this would incorrectly mark orgB's chatId as visible.
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
    await app.db
      .insert(chatMembership)
      .values({ chatId: crossOrgChatId, agentId: humanAgentId, role: "member", accessMode: "watcher" });

    // The event itself is written by an orgA agent (since the aggregate
    // query inner-joins agents on organizationId = orgA, only orgA agents
    // can produce events that even reach `recentRows`). The chat_id points
    // at orgB's chat — exactly the "dirty row" reviewer flagged.
    await sessionEventService.appendEvent(app.db, agent.uuid, crossOrgChatId, {
      kind: "context_tree_usage",
      payload: { purpose: "design_decision", treeRepoUrl: null },
    });

    const summary = await sessionEventService.summarizeContextTreeUsage(app.db, organizationId, 3, {
      humanAgentId,
      memberId,
    });
    expect(summary.recentEvents).toHaveLength(1);
    const event = summary.recentEvents[0];
    expect(event?.chatId).toBeNull();
    expect(event?.chatTitle).toBeNull();
  });

  it("masks chatId/chatTitle when the viewer has no chat access and does not supervise any speaker", async () => {
    const app = getApp();
    const { agent, organizationId } = await createTestAgent(app);
    const c = chatId();

    await app.db.insert(chats).values({ id: c, organizationId, type: "direct", topic: "private-chat" });
    await app.db
      .insert(chatMembership)
      .values({ chatId: c, agentId: agent.uuid, role: "member", accessMode: "speaker" });

    await sessionEventService.appendEvent(app.db, agent.uuid, c, {
      kind: "context_tree_usage",
      payload: { purpose: "design_decision", treeRepoUrl: null },
    });

    // A viewer with no human agent and no member id (e.g. a non-member of
    // the org calling somehow) gets nothing — neither branch can match.
    const summary = await sessionEventService.summarizeContextTreeUsage(app.db, organizationId, 3, {
      humanAgentId: null,
      memberId: null,
    });
    expect(summary.recentEvents).toHaveLength(1);
    const event = summary.recentEvents[0];
    expect(event?.chatId).toBeNull();
    expect(event?.chatTitle).toBeNull();
  });
});
