import { and, asc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { messages } from "../db/schema/messages.js";
import * as inboxService from "../services/inbox.js";
import { createTestAgent, useTestApp } from "./helpers.js";

/**
 * Scan-cost regression coverage for ACK-through (issue #1671).
 *
 * The behavioral contract lives in `inbox-ws-push.test.ts`. What this file
 * pins is the *cost* contract: committing an ack cursor must read only the
 * uncommitted tail of a chat, never the acked history behind it. That was the
 * quadratic-growth bug — every ACK selected and `FOR UPDATE`-locked every
 * same-chat notify row from the beginning of the chat through the cursor.
 *
 * Cost is measured with `EXPLAIN (ANALYZE)` over the exact predicate the
 * service runs (`uncommittedNotifyPrefixWhere`), counting rows the plan
 * actually examined — emitted rows plus rows thrown away by a filter. That
 * number is plan-shape independent, so the assertions hold whether PostgreSQL
 * picks the partial index, another index, or a sequential scan; a regression
 * that reintroduces the acked tail shows up as examined rows tracking history
 * depth no matter how the planner routes it.
 */
describe("inbox ACK scan cost", () => {
  const getApp = useTestApp();

  /** Deep enough that a history-proportional scan is unmistakable next to the
   *  handful of rows actually in flight, while still seeding in one INSERT. */
  const DEEP_HISTORY = 1_500;

  type SeededChat = {
    inboxId: string;
    chatId: string;
    /** id of the single `delivered` row at the top of the history */
    cursorId: number;
  };

  /**
   * Seed one chat whose inbox history is `ackedCount` committed notify rows
   * followed by a single delivered row awaiting ACK — the steady state of a
   * long-running chat with one message in flight.
   *
   * Rows are written directly rather than driven through the send/deliver
   * path: this test cares about scan shape at a depth the API path would take
   * minutes to reach.
   */
  async function seedChatHistory(app: FastifyInstance, ackedCount: number): Promise<SeededChat> {
    const uid = crypto.randomUUID().slice(0, 6);
    const sender = await createTestAgent(app, { name: `ackcost-s-${uid}` });
    const recipient = await createTestAgent(app, { name: `ackcost-r-${uid}` });
    const chatRes = await sender.request("POST", "/api/v1/agent/chats", {
      type: "group",
      participantIds: [recipient.agent.uuid],
    });
    const chatId: string = chatRes.json().id;
    const inboxId = recipient.agent.inboxId;

    const total = ackedCount + 1;
    const base = Date.now() - total * 1_000;
    const messageRows = Array.from({ length: total }, (_, i) => ({
      id: crypto.randomUUID(),
      chatId,
      senderId: sender.agent.uuid,
      format: "text",
      content: { text: `history ${i}` },
      source: "api",
      createdAt: new Date(base + i * 1_000),
    }));
    await app.db.insert(messages).values(messageRows);

    await app.db.insert(inboxEntries).values(
      messageRows.map((message, i) => {
        const committed = i < ackedCount;
        return {
          inboxId,
          messageId: message.id,
          chatId,
          notify: true,
          status: committed ? "acked" : "delivered",
          createdAt: message.createdAt,
          deliveredAt: message.createdAt,
          ackedAt: committed ? message.createdAt : null,
        };
      }),
    );

    // Without fresh statistics the planner works off defaults and may pick a
    // sequential scan purely because it assumes the table is tiny; every test
    // here starts from a TRUNCATEd table, so nothing has analyzed it yet.
    await app.db.execute(sql`ANALYZE inbox_entries`);

    const rows = await app.db
      .select({ id: inboxEntries.id })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.inboxId, inboxId), eq(inboxEntries.chatId, chatId)))
      .orderBy(asc(inboxEntries.id));
    const cursorId = rows.at(-1)?.id;
    if (cursorId === undefined) throw new Error("seeding produced no inbox rows");
    expect(rows).toHaveLength(total);
    return { inboxId, chatId, cursorId };
  }

  type ExplainNode = {
    "Node Type"?: string;
    "Index Name"?: string;
    "Actual Rows"?: number;
    "Rows Removed by Filter"?: number;
    Plans?: ExplainNode[];
  };

  function isExplainNode(value: unknown): value is ExplainNode {
    return typeof value === "object" && value !== null;
  }

  /** `EXPLAIN ... FORMAT JSON` comes back as `[{ "Plan": {...} }]`. Depending
   *  on driver-level json handling that value may still be a raw string, so
   *  accept both. */
  function extractPlanRoot(raw: unknown): ExplainNode {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const first = Array.isArray(parsed) ? parsed[0] : undefined;
    const root = isExplainNode(first) ? (first as { Plan?: unknown }).Plan : undefined;
    if (!isExplainNode(root)) throw new Error(`unexpected EXPLAIN output: ${JSON.stringify(parsed)}`);
    return root;
  }

  function flattenPlan(node: ExplainNode): ExplainNode[] {
    return [node, ...(node.Plans ?? []).flatMap(flattenPlan)];
  }

  type ScanCost = { examinedRows: number; indexNames: string[] };

  /**
   * Run the service's own ACK prefix predicate under `EXPLAIN (ANALYZE)` and
   * report how much of the table the plan touched. Scan nodes report emitted
   * rows and discarded rows separately, so the sum is the honest "rows the
   * database had to look at" figure.
   */
  async function measureAckPrefixScan(app: FastifyInstance, seeded: SeededChat): Promise<ScanCost> {
    const where = inboxService.uncommittedNotifyPrefixWhere({
      inboxId: seeded.inboxId,
      chatId: seeded.chatId,
      throughId: seeded.cursorId,
    });
    const explained = await app.db.execute<Record<string, unknown>>(
      sql`EXPLAIN (ANALYZE, FORMAT JSON) SELECT ${inboxEntries.id}, ${inboxEntries.status}, ${inboxEntries.deliveredAt} FROM ${inboxEntries} WHERE ${where} ORDER BY ${inboxEntries.id}`,
    );
    const planColumn = explained[0]?.["QUERY PLAN"];
    const nodes = flattenPlan(extractPlanRoot(planColumn));
    const scanNodes = nodes.filter((node) => node["Node Type"]?.includes("Scan"));
    return {
      examinedRows: scanNodes.reduce(
        (sum, node) => sum + Number(node["Actual Rows"] ?? 0) + Number(node["Rows Removed by Filter"] ?? 0),
        0,
      ),
      indexNames: nodes.flatMap((node) => (node["Index Name"] ? [node["Index Name"]] : [])),
    };
  }

  it("reads only the uncommitted tail, not the acked history behind the cursor", async () => {
    const app = getApp();
    const seeded = await seedChatHistory(app, DEEP_HISTORY);

    const { examinedRows, indexNames } = await measureAckPrefixScan(app, seeded);

    // One delivered row is in flight; anything approaching DEEP_HISTORY means
    // the acked tail is back in the scan.
    expect(examinedRows).toBeLessThanOrEqual(8);
    expect(indexNames).toContain("idx_inbox_ack_prefix");
  });

  it("does not get more expensive as history grows", async () => {
    const app = getApp();

    const shallow = await measureAckPrefixScan(app, await seedChatHistory(app, 1));
    const deep = await measureAckPrefixScan(app, await seedChatHistory(app, DEEP_HISTORY));

    // Flat, not proportional — the whole point of the fix. Deep may even come
    // in lower: a two-row table is cheapest to scan outright, while a deep one
    // goes through the partial index and touches only the in-flight row.
    // Comparative rather than a fixed bound so the assertion survives future
    // changes to how many rows a chat keeps in flight.
    expect(deep.examinedRows).toBeLessThanOrEqual(shallow.examinedRows);
  });

  it("commits and stays idempotent over a deep acked history", async () => {
    const app = getApp();
    const seeded = await seedChatHistory(app, DEEP_HISTORY);

    const accepted = await inboxService.ackEntryByIdForBoundAgents(app.db, seeded.cursorId, [seeded.inboxId]);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error("ack-through unexpectedly rejected");
    // Only the in-flight row is committed — the acked history is not re-acked,
    // and its ids do not leak into the WS in-flight bookkeeping the caller
    // drives off `ackedEntryIds`.
    expect(accepted.disposition).toBe("acked");
    expect(accepted.ackedCount).toBe(1);
    expect(accepted.ackedEntryIds).toEqual([seeded.cursorId]);

    const duplicate = await inboxService.ackEntryByIdForBoundAgents(app.db, seeded.cursorId, [seeded.inboxId]);
    expect(duplicate.ok).toBe(true);
    if (!duplicate.ok) throw new Error("duplicate ack unexpectedly rejected");
    expect(duplicate.disposition).toBe("already_acked");
    expect(duplicate.ackedCount).toBe(0);

    const stillPending = await app.db
      .select({ id: inboxEntries.id })
      .from(inboxEntries)
      .where(
        and(
          eq(inboxEntries.inboxId, seeded.inboxId),
          eq(inboxEntries.chatId, seeded.chatId),
          eq(inboxEntries.status, "delivered"),
        ),
      );
    expect(stillPending).toHaveLength(0);
  });

  it("rejects a prefix gap that is buried under a deep acked history", async () => {
    const app = getApp();
    const seeded = await seedChatHistory(app, DEEP_HISTORY);

    // Knock the row just below the cursor back to never-delivered. The delta
    // scan must still see it: dropping acked rows must not drop uncommitted
    // ones, or ACK-through would silently commit past a hole.
    const [gap] = await app.db
      .select({ id: inboxEntries.id })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.inboxId, seeded.inboxId), eq(inboxEntries.id, seeded.cursorId - 1)))
      .limit(1);
    if (!gap) throw new Error("expected a row below the cursor");
    await app.db
      .update(inboxEntries)
      .set({ status: "pending", deliveredAt: null, ackedAt: null })
      .where(eq(inboxEntries.id, gap.id));

    const rejected = await inboxService.ackEntryByIdForBoundAgents(app.db, seeded.cursorId, [seeded.inboxId]);
    expect(rejected).toEqual({ ok: false, reason: "prefix_gap" });
  });
});
