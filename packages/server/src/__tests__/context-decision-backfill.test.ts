import { CONTEXT_DECISION_METADATA_KEY, type ContextDecision } from "@first-tree/shared";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { chats } from "../db/schema/chats.js";
import { messages } from "../db/schema/messages.js";
import { backfillContextDecisionFromNotes } from "../services/context-tree/influence-backfill.js";
import { createTestAgent, useTestApp } from "./helpers.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const REPO = "https://github.com/acme/first-tree-context";
const NODE = "system/cloud/team/tenancy-and-identity.md";
const SOURCE = `[Organization isolation](${REPO}/blob/${COMMIT}/${NODE})`;

const getApp = useTestApp();

const WINDOW = { since: new Date(Date.now() - 24 * 60 * 60 * 1000), until: new Date(Date.now() + 60 * 1000) };

function backfill(overrides: Record<string, unknown> = {}) {
  return backfillContextDecisionFromNotes(getApp().db, { apply: true, ...WINDOW, ...overrides });
}

function noteBody(options: { effectLine?: string; sourceLine?: string; repeat?: number } = {}): string {
  const note = [
    "> How Context Tree affected this work\\",
    `> ${options.effectLine ?? "**Options narrowed:** The organization-isolation rule ruled out a global shared index."}\\`,
    `> ${options.sourceLine ?? `Context Tree source: ${SOURCE}`}`,
  ].join("\n");
  return ["Keeping the index per organization.", ...Array(options.repeat ?? 1).fill(`\n${note}`)].join("\n");
}

async function seedChat() {
  const app = getApp();
  const seed = await createTestAgent(app);
  const chatId = `chat-${crypto.randomUUID()}`;
  await app.db.insert(chats).values({ id: chatId, organizationId: seed.organizationId, type: "direct", topic: "b" });
  return { ...seed, chatId };
}

async function insertMessage(
  chatId: string,
  senderId: string,
  content: unknown,
  metadata: Record<string, unknown> = {},
  createdAt?: Date,
): Promise<string> {
  const id = `msg-${crypto.randomUUID()}`;
  await getApp()
    .db.insert(messages)
    .values({
      id,
      chatId,
      senderId,
      format: "markdown",
      content,
      metadata,
      source: "cli",
      ...(createdAt ? { createdAt } : {}),
    });
  return id;
}

async function metadataOf(id: string): Promise<Record<string, unknown>> {
  const [row] = await getApp().db.select({ metadata: messages.metadata }).from(messages).where(eq(messages.id, id));
  return row?.metadata ?? {};
}

describe("contextDecision backfill from impact notes", () => {
  it("derives a receipt and preserves every other metadata key", async () => {
    const seed = await seedChat();
    const id = await insertMessage(seed.chatId, seed.agent.uuid, noteBody(), { mentions: ["someone"] });

    const report = await backfill();
    expect(report.tally.derived).toBe(1);

    const metadata = await metadataOf(id);
    expect(metadata[CONTEXT_DECISION_METADATA_KEY]).toEqual({
      version: 1,
      effect: "constrained",
      summary: "The organization-isolation rule ruled out a global shared index.",
      evidence: [{ repoUrl: REPO, commit: COMMIT, nodePath: NODE, heading: "Organization isolation" }],
    });
    // A whole-object replace would have dropped this.
    expect(metadata.mentions).toEqual(["someone"]);
  });

  it("writes nothing without --apply", async () => {
    const seed = await seedChat();
    const id = await insertMessage(seed.chatId, seed.agent.uuid, noteBody());

    const report = await backfill({ apply: false });
    expect(report.tally.derived).toBe(1);
    expect(await metadataOf(id)).toEqual({});
  });

  // The write-time path owns any row that already has one; a backfill
  // re-deriving it would be a second authority over the same fact.
  it("never overwrites an existing receipt", async () => {
    const seed = await seedChat();
    const existing: ContextDecision = {
      version: 1,
      effect: "conflicted",
      summary: "Recorded earlier by the write path.",
      evidence: [{ repoUrl: REPO, commit: COMMIT, nodePath: "operations/release/safety-gates.md" }],
    };
    const id = await insertMessage(seed.chatId, seed.agent.uuid, noteBody(), {
      [CONTEXT_DECISION_METADATA_KEY]: existing,
    });

    const report = await backfill();
    expect(report.scanned).toBe(0);
    expect((await metadataOf(id))[CONTEXT_DECISION_METADATA_KEY]).toEqual(existing);
  });

  it("skips a human sender who merely quoted a note", async () => {
    const seed = await seedChat();
    const id = await insertMessage(seed.chatId, seed.humanAgentUuid, noteBody());

    const report = await backfill();
    expect(report.scanned).toBe(0);
    expect(await metadataOf(id)).toEqual({});
  });

  it("counts but does not write notes it cannot convert", async () => {
    const seed = await seedChat();
    const unknownEffect = await insertMessage(
      seed.chatId,
      seed.agent.uuid,
      noteBody({ effectLine: "**Mostly helpful:** It went fine." }),
    );
    const branchLink = await insertMessage(
      seed.chatId,
      seed.agent.uuid,
      noteBody({ sourceLine: `Context Tree source: [Isolation](${REPO}/blob/main/a.md)` }),
    );
    const twoNotes = await insertMessage(seed.chatId, seed.agent.uuid, noteBody({ repeat: 2 }));

    const report = await backfill();
    expect(report.tally.derived).toBe(0);
    expect(report.tally.unconvertible).toBe(2);
    expect(report.tally.two_notes).toBe(1);
    for (const id of [unknownEffect, branchLink, twoNotes]) {
      expect(await metadataOf(id)).toEqual({});
    }
  });

  it("scopes to one organization when asked", async () => {
    const seed = await seedChat();
    const other = await seedChat();
    const mine = await insertMessage(seed.chatId, seed.agent.uuid, noteBody());
    const theirs = await insertMessage(other.chatId, other.agent.uuid, noteBody());

    // Both test agents share the default org, so an org filter that matched
    // nothing would silently look like success — assert the positive case with
    // a deliberately absent org instead.
    const absent = await backfill({ organizationId: `org-${crypto.randomUUID()}` });
    expect(absent.scanned).toBe(0);
    expect(await metadataOf(mine)).toEqual({});

    const scoped = await backfill({ organizationId: seed.organizationId });
    expect(scoped.tally.derived).toBe(2);
    expect((await metadataOf(mine))[CONTEXT_DECISION_METADATA_KEY]).toBeDefined();
    expect((await metadataOf(theirs))[CONTEXT_DECISION_METADATA_KEY]).toBeDefined();
  });

  // The window is the whole point: an unbounded run would let a later operator
  // rewrite rows the write path deliberately left receipt-free.
  it("ignores messages outside the declared window", async () => {
    const seed = await seedChat();
    const id = await insertMessage(seed.chatId, seed.agent.uuid, noteBody());

    const before = await backfill({
      since: new Date(Date.now() - 48 * 60 * 60 * 1000),
      until: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });
    expect(before.scanned).toBe(0);
    expect(await metadataOf(id)).toEqual({});

    expect((await backfill()).tally.derived).toBe(1);
  });

  // A fractional bound is not a bound: `maxRows: 1.5` would examine and mutate
  // two rows while advertising one, on a destructive run.
  it("rejects a fractional row bound", async () => {
    await expect(backfill({ maxRows: 1.5 })).rejects.toThrow(/maxRows must be a positive integer/);
    await expect(backfill({ pageSize: 2.5 })).rejects.toThrow(/pageSize must be a positive integer/);
  });

  it("rejects an inverted window", async () => {
    await expect(backfill({ since: WINDOW.until, until: WINDOW.since })).rejects.toThrow(/since must not be after/);
  });

  // Unconvertible rows stay candidates forever and sort first. A plain LIMIT
  // would rescan them on every rerun and never reach the messages behind them.
  it("pages past unconvertible rows to reach later convertible ones", async () => {
    const seed = await seedChat();
    // Explicit, increasing timestamps: the convertible row must sort LAST so a
    // non-paginating implementation would stop before ever reaching it.
    const base = Date.now() - 60 * 60 * 1000;
    const blockers: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      blockers.push(
        await insertMessage(
          seed.chatId,
          seed.agent.uuid,
          noteBody({ effectLine: "**Mostly helpful:** fine." }),
          {},
          new Date(base + index * 1000),
        ),
      );
    }
    const convertible = await insertMessage(seed.chatId, seed.agent.uuid, noteBody(), {}, new Date(base + 10_000));

    // Counts are org-wide and this suite shares one org, so assert on the rows
    // this test owns rather than on the run's totals.
    const report = await backfill({ pageSize: 2 });
    expect(report.scanned).toBeGreaterThan(2);
    expect((await metadataOf(convertible))[CONTEXT_DECISION_METADATA_KEY]).toBeDefined();
    for (const id of blockers) expect(await metadataOf(id)).toEqual({});
  });

  // maxRows must be an exact bound on what a run touches, and the keyset cursor
  // lives only in memory — so a run that stops early has to hand back a resume
  // point or the operator's rerun restarts at the window's beginning.
  it("stops exactly at maxRows and reports a usable resume cursor", async () => {
    const seed = await seedChat();
    const base = Date.now() - 60 * 60 * 1000;
    const ids: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      ids.push(await insertMessage(seed.chatId, seed.agent.uuid, noteBody(), {}, new Date(base + index * 1000)));
    }

    const first = await backfill({ organizationId: seed.organizationId, maxRows: 2, pageSize: 10 });
    expect(first.scanned).toBe(2);
    expect(first.stoppedAtMaxRows).toBe(true);
    expect(first.nextCursor).not.toBeNull();
    expect((await metadataOf(ids[0] as string))[CONTEXT_DECISION_METADATA_KEY]).toBeDefined();
    expect(await metadataOf(ids[3] as string)).toEqual({});

    const resumed = await backfill({
      organizationId: seed.organizationId,
      resumeAfter: { createdAt: first.nextCursor?.createdAt ?? "", id: first.nextCursor?.id ?? "" },
    });
    expect(resumed.tally.derived).toBe(2);
    for (const id of ids) expect((await metadataOf(id))[CONTEXT_DECISION_METADATA_KEY]).toBeDefined();
  });

  // `timestamptz` keeps microseconds; a JavaScript Date keeps milliseconds. A
  // cursor that round-trips through Date rounds DOWN, so the next comparison
  // re-selects the row it was meant to skip — with maxRows 1 on an
  // unconvertible boundary row, every resumed run stops on it forever.
  it("resumes past a row whose timestamp carries microseconds", async () => {
    const app = getApp();
    const seed = await seedChat();
    const blocker = await insertMessage(
      seed.chatId,
      seed.agent.uuid,
      noteBody({ effectLine: "**Mostly helpful:** fine." }),
    );
    const convertible = await insertMessage(seed.chatId, seed.agent.uuid, noteBody());
    await app.db.execute(
      sql`UPDATE messages SET created_at = '2026-08-10 10:00:00.123456+00'::timestamptz WHERE id = ${blocker}`,
    );
    await app.db.execute(
      sql`UPDATE messages SET created_at = '2026-08-10 10:00:00.223456+00'::timestamptz WHERE id = ${convertible}`,
    );
    const window = { since: new Date("2026-08-10T09:00:00Z"), until: new Date("2026-08-10T11:00:00Z") };

    const first = await backfill({ ...window, organizationId: seed.organizationId, maxRows: 1 });
    expect(first.scanned).toBe(1);
    expect(first.nextCursor?.createdAt).toContain("123456");

    const resumed = await backfill({
      ...window,
      organizationId: seed.organizationId,
      maxRows: 1,
      resumeAfter: { createdAt: first.nextCursor?.createdAt ?? "", id: first.nextCursor?.id ?? "" },
    });
    // A rounded cursor would have re-selected the blocker and derived nothing.
    expect(resumed.tally.derived).toBe(1);
    expect((await metadataOf(convertible))[CONTEXT_DECISION_METADATA_KEY]).toBeDefined();
  });

  it("ignores a body with no note at all", async () => {
    const seed = await seedChat();
    await insertMessage(seed.chatId, seed.agent.uuid, "Shipped the per-org index.");

    expect((await backfill()).scanned).toBe(0);
  });
});
