import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { sessionEvents } from "../db/schema/session-events.js";
import * as sessionEventService from "../services/session-event.js";
import { useTestApp } from "./helpers.js";

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
});
