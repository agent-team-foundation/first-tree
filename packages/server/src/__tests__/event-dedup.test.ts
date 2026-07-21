import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { connectDatabase, type Database } from "../db/connection.js";
import * as eventDedup from "../services/event-dedup.js";
import { useTestApp } from "./helpers.js";

type ExplainNode = {
  "Node Type"?: string;
  "Index Name"?: string;
  Plans?: ExplainNode[];
};

function transactionDatabase(tx: unknown): Database {
  return tx as Database;
}

function namedDatabase(prefix: string): { db: Database; applicationName: string } {
  const applicationName = `${prefix}-${randomUUID()}`;
  const url = new URL(process.env.DATABASE_URL ?? "");
  url.searchParams.set("application_name", applicationName);
  return { db: connectDatabase(url.toString()), applicationName };
}

async function insertExpiredPending(db: Database, eventId: string, platform = "github"): Promise<Date> {
  const rows = await db.execute<{ expires_at: Date | string }>(sql`
    INSERT INTO processed_events (event_id, platform, status, expires_at)
    VALUES (
      ${eventId},
      ${platform},
      'pending',
      date_trunc('milliseconds', clock_timestamp()) - interval '1 second'
    )
    RETURNING expires_at
  `);
  const value = rows[0]?.expires_at;
  if (!value) throw new Error("expired pending fixture was not inserted");
  return value instanceof Date ? value : new Date(value);
}

async function waitUntilBlocked(db: Database, applicationName: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const rows = await db.execute<{ blocked: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1
        FROM pg_stat_activity
        WHERE application_name = ${applicationName}
          AND cardinality(pg_blocking_pids(pid)) > 0
      ) AS blocked
    `);
    if (rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`database application ${applicationName} did not enter a lock wait`);
}

function flattenPlan(node: ExplainNode): ExplainNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flattenPlan)];
}

describe("Event claim lifecycle", () => {
  const getApp = useTestApp();

  it("acquires, completes, and permanently dedupes only a done event", async () => {
    const app = getApp();
    const acquired = await eventDedup.claimEvent(app.db, "evt_done_1", "github");
    expect(acquired).toMatchObject({ outcome: "acquired", expiresAt: expect.any(Date) });
    if (acquired.outcome !== "acquired") throw new Error("claim was not acquired");

    const inFlight = await eventDedup.claimEvent(app.db, "evt_done_1", "github");
    expect(inFlight).toMatchObject({
      outcome: "in_flight",
      expiresAt: acquired.expiresAt,
      retryAfterSeconds: expect.any(Number),
    });
    if (inFlight.outcome !== "in_flight") throw new Error("claim was not in flight");
    expect(inFlight.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(inFlight.retryAfterSeconds).toBeLessThanOrEqual(eventDedup.EVENT_CLAIM_TTL_SECONDS);

    await eventDedup.completeEventClaim(app.db, "evt_done_1", "github", acquired.expiresAt);
    await expect(eventDedup.claimEvent(app.db, "evt_done_1", "github")).resolves.toEqual({ outcome: "done" });
  });

  it("isolates identical delivery ids by provider", async () => {
    const app = getApp();
    const [github, gitlab] = await Promise.all([
      eventDedup.claimEvent(app.db, "evt_cross_1", "github"),
      eventDedup.claimEvent(app.db, "evt_cross_1", "gitlab"),
    ]);
    expect(github.outcome).toBe("acquired");
    expect(gitlab.outcome).toBe("acquired");
  });

  it("allows exactly one initial acquirer while the generation remains pending", async () => {
    const app = getApp();
    const results = await Promise.all(
      Array.from({ length: 12 }, () => eventDedup.claimEvent(app.db, "evt_concurrent_initial", "github")),
    );
    expect(results.filter((result) => result.outcome === "acquired")).toHaveLength(1);
    expect(results.filter((result) => result.outcome === "in_flight")).toHaveLength(11);
    expect(results.filter((result) => result.outcome === "done")).toHaveLength(0);
  });

  it("allows exactly one expired-generation takeover", async () => {
    const app = getApp();
    await insertExpiredPending(app.db, "evt_concurrent_takeover");

    const results = await Promise.all(
      Array.from({ length: 12 }, () => eventDedup.claimEvent(app.db, "evt_concurrent_takeover", "github")),
    );
    expect(results.filter((result) => result.outcome === "acquired")).toHaveLength(1);
    expect(results.filter((result) => result.outcome === "in_flight")).toHaveLength(11);
    expect(results.filter((result) => result.outcome === "done")).toHaveLength(0);
  });

  it("rejects completion from an owner whose expired generation was taken over", async () => {
    const app = getApp();
    const staleExpiry = await insertExpiredPending(app.db, "evt_stale_owner");
    const takeover = await eventDedup.claimEvent(app.db, "evt_stale_owner", "github");
    expect(takeover.outcome).toBe("acquired");

    await expect(eventDedup.completeEventClaim(app.db, "evt_stale_owner", "github", staleExpiry)).rejects.toThrow(
      "lost ownership",
    );
    await expect(eventDedup.claimEvent(app.db, "evt_stale_owner", "github")).resolves.toMatchObject({
      outcome: "in_flight",
    });
  });

  it("deletes exactly one 1,000-row expired batch and preserves live pending and done rows", async () => {
    const app = getApp();
    await app.db.execute(sql`
      INSERT INTO processed_events (event_id, platform, status, expires_at)
      SELECT
        'expired-' || sequence::text,
        'github',
        'pending',
        statement_timestamp() - interval '1 minute'
      FROM generate_series(1, 1001) AS sequence
    `);
    await app.db.execute(sql`
      INSERT INTO processed_events (event_id, platform, status, expires_at)
      VALUES
        ('live-pending', 'github', 'pending', statement_timestamp() + interval '1 minute'),
        ('completed', 'github', 'done', NULL)
    `);

    await expect(eventDedup.sweepExpiredEventClaims(app.db)).resolves.toBe(1_000);
    await expect(eventDedup.sweepExpiredEventClaims(app.db)).resolves.toBe(1);
    await expect(eventDedup.sweepExpiredEventClaims(app.db)).resolves.toBe(0);

    const remaining = await app.db.execute<{ event_id: string; status: string }>(sql`
      SELECT event_id, status
      FROM processed_events
      ORDER BY event_id
    `);
    expect(remaining).toEqual([
      expect.objectContaining({ event_id: "completed", status: "done" }),
      expect.objectContaining({ event_id: "live-pending", status: "pending" }),
    ]);
  });

  it("installs the ordered partial index used by the expired-pending sweep", async () => {
    const app = getApp();
    const indexes = await app.db.execute<{ indexdef: string }>(sql`
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename = 'processed_events'
        AND indexname = 'idx_processed_events_pending_expiry'
    `);
    expect(indexes).toHaveLength(1);
    expect(indexes[0]?.indexdef).toContain("USING btree (expires_at, id)");
    expect(indexes[0]?.indexdef).toMatch(/WHERE \(status = 'pending'::text\)$/);

    await app.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      const planRows = await tx.execute<{ "QUERY PLAN": unknown }>(sql`
        EXPLAIN (FORMAT JSON, COSTS OFF)
        WITH sweep_clock AS MATERIALIZED (
          SELECT statement_timestamp() AS cutoff
        )
        SELECT pe.id
        FROM processed_events AS pe
        WHERE pe.status = 'pending'
          AND pe.expires_at <= (SELECT cutoff FROM sweep_clock)
        ORDER BY pe.expires_at ASC, pe.id ASC
        FOR UPDATE OF pe SKIP LOCKED
        LIMIT ${eventDedup.EVENT_CLAIM_SWEEP_BATCH_SIZE}
      `);
      const rawPlan = planRows[0]?.["QUERY PLAN"];
      const parsedPlan = typeof rawPlan === "string" ? (JSON.parse(rawPlan) as unknown) : rawPlan;
      if (!Array.isArray(parsedPlan) || typeof parsedPlan[0] !== "object" || parsedPlan[0] === null) {
        throw new Error("PostgreSQL returned an unexpected sweep plan");
      }
      const root = (parsedPlan[0] as { Plan?: ExplainNode }).Plan;
      if (!root) throw new Error("PostgreSQL sweep plan has no root node");
      const nodes = flattenPlan(root);
      expect(nodes.some((node) => node["Index Name"] === "idx_processed_events_pending_expiry")).toBe(true);
      expect(nodes.some((node) => node["Node Type"] === "Sort")).toBe(false);
    });
  });

  it("does not let a sweep delete a takeover generation that already holds the row lock", async () => {
    const app = getApp();
    await insertExpiredPending(app.db, "evt_takeover_before_sweep");
    const owner = namedDatabase("takeover-owner");
    let releaseOwner!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    let ownerEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      ownerEntered = resolve;
    });

    const takeover = owner.db.transaction(async (tx) => {
      const result = await eventDedup.claimEvent(transactionDatabase(tx), "evt_takeover_before_sweep", "github");
      ownerEntered();
      await release;
      return result;
    });
    try {
      await entered;
      await expect(eventDedup.sweepExpiredEventClaims(app.db)).resolves.toBe(0);
      releaseOwner();
      await expect(takeover).resolves.toMatchObject({ outcome: "acquired" });
      await expect(eventDedup.claimEvent(app.db, "evt_takeover_before_sweep", "github")).resolves.toMatchObject({
        outcome: "in_flight",
      });
    } finally {
      releaseOwner();
      await Promise.allSettled([takeover]);
      await owner.db.end();
    }
  });

  it("lets acquisition insert a fresh generation after a sweep commits first", async () => {
    const app = getApp();
    await insertExpiredPending(app.db, "evt_sweep_before_takeover");
    const sweeper = namedDatabase("held-sweeper");
    const claimant = namedDatabase("blocked-claimant");
    let releaseSweep!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseSweep = resolve;
    });
    let sweepEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      sweepEntered = resolve;
    });
    const sweeping = sweeper.db.transaction(async (tx) => {
      const deleted = await eventDedup.sweepExpiredEventClaims(transactionDatabase(tx));
      sweepEntered();
      await release;
      return deleted;
    });

    let acquiring: ReturnType<typeof eventDedup.claimEvent> | undefined;
    try {
      await entered;
      acquiring = eventDedup.claimEvent(claimant.db, "evt_sweep_before_takeover", "github");
      await waitUntilBlocked(app.db, claimant.applicationName);
      releaseSweep();
      await expect(sweeping).resolves.toBe(1);
      await expect(acquiring).resolves.toMatchObject({ outcome: "acquired" });
    } finally {
      releaseSweep();
      await Promise.allSettled([sweeping, ...(acquiring ? [acquiring] : [])]);
      await Promise.all([sweeper.db.end(), claimant.db.end()]);
    }
  });

  it("preserves a completion that locks and marks done before the sweep", async () => {
    const app = getApp();
    const expiry = await insertExpiredPending(app.db, "evt_complete_before_sweep");
    const owner = namedDatabase("completion-owner");
    let releaseOwner!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    let ownerEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      ownerEntered = resolve;
    });
    const completion = owner.db.transaction(async (tx) => {
      await eventDedup.completeEventClaim(transactionDatabase(tx), "evt_complete_before_sweep", "github", expiry);
      ownerEntered();
      await release;
    });
    try {
      await entered;
      await expect(eventDedup.sweepExpiredEventClaims(app.db)).resolves.toBe(0);
      releaseOwner();
      await completion;
      await expect(eventDedup.claimEvent(app.db, "evt_complete_before_sweep", "github")).resolves.toEqual({
        outcome: "done",
      });
    } finally {
      releaseOwner();
      await Promise.allSettled([completion]);
      await owner.db.end();
    }
  });

  it("makes an expired owner's completion fail if the sweep commits first", async () => {
    const app = getApp();
    const expiry = await insertExpiredPending(app.db, "evt_sweep_before_complete");
    const sweeper = namedDatabase("completion-sweeper");
    const owner = namedDatabase("blocked-completer");
    let releaseSweep!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseSweep = resolve;
    });
    let sweepEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      sweepEntered = resolve;
    });
    const sweeping = sweeper.db.transaction(async (tx) => {
      const deleted = await eventDedup.sweepExpiredEventClaims(transactionDatabase(tx));
      sweepEntered();
      await release;
      return deleted;
    });
    let completion: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;
    try {
      await entered;
      completion = eventDedup.completeEventClaim(owner.db, "evt_sweep_before_complete", "github", expiry).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await waitUntilBlocked(app.db, owner.applicationName);
      releaseSweep();
      await expect(sweeping).resolves.toBe(1);
      const completionResult = await completion;
      expect(completionResult.ok).toBe(false);
      if (completionResult.ok) throw new Error("expired owner unexpectedly completed a swept claim");
      expect(completionResult.error).toMatchObject({ message: expect.stringContaining("lost ownership") });
    } finally {
      releaseSweep();
      await Promise.allSettled([sweeping, ...(completion ? [completion] : [])]);
      await Promise.all([sweeper.db.end(), owner.db.end()]);
    }
  });
});
