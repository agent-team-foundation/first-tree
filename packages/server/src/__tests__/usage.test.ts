import { describe, expect, it } from "vitest";
import * as sessionEventService from "../services/session-event.js";
import * as usageService from "../services/usage.js";
import { createTestAgent, useTestApp } from "./helpers.js";

/**
 * Tests for the token-usage aggregation service. Exercises:
 *   - aggregateByAgent: per-org GROUP BY agent (incl. zero-usage rows)
 *   - summarizeAgent:   totals + daily bucket projection
 *   - listAgentTurns:   pagination + chat-name participant gating
 *
 * Each helper writes real `token_usage` events through `appendEvent` so the
 * partial-index path + JSONB cast logic in the service are covered, not just
 * the pure-function projection on top.
 */

function tokenUsage(opts: { input: number; cached?: number; output: number; model?: string }) {
  return {
    kind: "token_usage" as const,
    payload: {
      provider: "claude-code",
      model: opts.model ?? "claude-opus-4-6",
      inputTokens: opts.input,
      cachedInputTokens: opts.cached ?? 0,
      outputTokens: opts.output,
    },
  };
}

const FAR_FUTURE = new Date("9999-12-31T00:00:00Z");
const EPOCH = new Date("1970-01-01T00:00:00Z");

describe("usageService.aggregateByAgent", () => {
  const getApp = useTestApp();

  it("returns zero-row entry for an org with one agent but no token_usage events", async () => {
    const app = getApp();
    const { agent } = await createTestAgent(app);

    const rows = await usageService.aggregateByAgent(app.db, {
      organizationId: agent.organizationId,
      from: EPOCH,
      to: FAR_FUTURE,
    });

    const row = rows.find((r) => r.agentId === agent.uuid);
    expect(row).toBeDefined();
    expect(row?.inputTokens).toBe(0);
    expect(row?.cachedInputTokens).toBe(0);
    expect(row?.outputTokens).toBe(0);
    expect(row?.turns).toBe(0);
  });

  it("sums multiple token_usage events for one agent", async () => {
    const app = getApp();
    const { agent } = await createTestAgent(app);
    const chatId = `chat-${crypto.randomUUID()}`;

    await sessionEventService.appendEvent(app.db, agent.uuid, chatId, tokenUsage({ input: 100, output: 10 }));
    await sessionEventService.appendEvent(
      app.db,
      agent.uuid,
      chatId,
      tokenUsage({ input: 200, cached: 50, output: 20 }),
    );

    const rows = await usageService.aggregateByAgent(app.db, {
      organizationId: agent.organizationId,
      from: EPOCH,
      to: FAR_FUTURE,
    });
    const row = rows.find((r) => r.agentId === agent.uuid);
    expect(row).toEqual({ agentId: agent.uuid, inputTokens: 300, cachedInputTokens: 50, outputTokens: 30, turns: 2 });
  });

  it("groups per agent within the same org", async () => {
    const app = getApp();
    // The default-org seed in createTestAdmin returns the same org for every
    // call (resolveDefaultOrgId), so a1 and a2 share an org. GROUP BY must
    // still keep their numbers separate.
    const { agent: a1, organizationId } = await createTestAgent(app);
    const { agent: a2 } = await createTestAgent(app);
    const chat = `chat-${crypto.randomUUID()}`;

    await sessionEventService.appendEvent(app.db, a1.uuid, chat, tokenUsage({ input: 10, output: 1 }));
    await sessionEventService.appendEvent(app.db, a2.uuid, chat, tokenUsage({ input: 999, output: 99 }));

    const rows = await usageService.aggregateByAgent(app.db, { organizationId, from: EPOCH, to: FAR_FUTURE });
    const row1 = rows.find((r) => r.agentId === a1.uuid);
    const row2 = rows.find((r) => r.agentId === a2.uuid);
    expect(row1?.inputTokens).toBe(10);
    expect(row1?.turns).toBe(1);
    expect(row2?.inputTokens).toBe(999);
    expect(row2?.turns).toBe(1);
  });
});

describe("usageService.summarizeAgent", () => {
  const getApp = useTestApp();

  it("returns zero totals + empty daily for an agent with no events", async () => {
    const app = getApp();
    const { agent } = await createTestAgent(app);

    const summary = await usageService.summarizeAgent(app.db, {
      agentId: agent.uuid,
      from: EPOCH,
      to: FAR_FUTURE,
    });

    expect(summary.agentId).toBe(agent.uuid);
    expect(summary.totals.inputTokens).toBe(0);
    expect(summary.totals.turns).toBe(0);
    expect(summary.totals.chats).toBe(0);
    expect(summary.totals.lastUsageAt).toBeNull();
    expect(summary.daily).toEqual([]);
  });

  it("aggregates totals and emits one daily bucket per active UTC day", async () => {
    const app = getApp();
    const { agent } = await createTestAgent(app);
    const chat = `chat-${crypto.randomUUID()}`;

    await sessionEventService.appendEvent(app.db, agent.uuid, chat, tokenUsage({ input: 100, cached: 10, output: 5 }));
    await sessionEventService.appendEvent(app.db, agent.uuid, chat, tokenUsage({ input: 200, output: 10 }));

    // `to` must be near "now" so the 90-day grid window starting at `to - 90d`
    // includes the just-written events. FAR_FUTURE would push the grid window
    // beyond the events and produce an empty `daily`.
    const now = new Date(Date.now() + 60_000);
    const summary = await usageService.summarizeAgent(app.db, {
      agentId: agent.uuid,
      from: EPOCH,
      to: now,
    });

    expect(summary.totals.inputTokens).toBe(300);
    expect(summary.totals.cachedInputTokens).toBe(10);
    expect(summary.totals.outputTokens).toBe(15);
    expect(summary.totals.turns).toBe(2);
    expect(summary.totals.chats).toBe(1);
    expect(summary.totals.lastUsageAt).not.toBeNull();
    // Both events landed in the same calendar day (transaction time).
    expect(summary.daily.length).toBe(1);
    expect(summary.daily[0]?.inputTokens).toBe(300);
    expect(summary.daily[0]?.turns).toBe(2);
  });
});

describe("usageService.listAgentTurns", () => {
  const getApp = useTestApp();

  it("returns turns sorted by createdAt DESC and supports cursor pagination", async () => {
    const app = getApp();
    const { agent } = await createTestAgent(app);
    const chat = `chat-${crypto.randomUUID()}`;

    // Three events; service sorts by createdAt DESC.
    await sessionEventService.appendEvent(app.db, agent.uuid, chat, tokenUsage({ input: 1, output: 1 }));
    await sessionEventService.appendEvent(app.db, agent.uuid, chat, tokenUsage({ input: 2, output: 2 }));
    await sessionEventService.appendEvent(app.db, agent.uuid, chat, tokenUsage({ input: 3, output: 3 }));

    const first = await usageService.listAgentTurns(app.db, {
      agentId: agent.uuid,
      from: EPOCH,
      to: FAR_FUTURE,
      cursor: null,
      limit: 2,
      viewer: null,
    });
    expect(first.rows).toHaveLength(2);
    expect(first.rows[0]?.inputTokens).toBe(3);
    expect(first.rows[1]?.inputTokens).toBe(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await usageService.listAgentTurns(app.db, {
      agentId: agent.uuid,
      from: EPOCH,
      to: FAR_FUTURE,
      cursor: first.nextCursor,
      limit: 2,
      viewer: null,
    });
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0]?.inputTokens).toBe(1);
    expect(second.nextCursor).toBeNull();
  });

  it("masks chatTitle when viewer is not a chat participant", async () => {
    const app = getApp();
    const { agent } = await createTestAgent(app);
    const chat = `chat-${crypto.randomUUID()}`;
    await sessionEventService.appendEvent(app.db, agent.uuid, chat, tokenUsage({ input: 1, output: 1 }));

    const result = await usageService.listAgentTurns(app.db, {
      agentId: agent.uuid,
      from: EPOCH,
      to: FAR_FUTURE,
      cursor: null,
      limit: 10,
      // Viewer has a human-agent id that is NOT a chat_membership row for `chat`.
      viewer: { humanAgentId: `outsider-${crypto.randomUUID()}` },
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.chatTitle).toBeNull();
    // chatId itself stays visible — only the human-readable name is gated.
    expect(result.rows[0]?.chatId).toBe(chat);
  });
});
