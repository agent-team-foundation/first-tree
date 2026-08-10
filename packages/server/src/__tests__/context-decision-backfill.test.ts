import { CONTEXT_DECISION_METADATA_KEY, type ContextDecision } from "@first-tree/shared";
import { eq } from "drizzle-orm";
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
): Promise<string> {
  const id = `msg-${crypto.randomUUID()}`;
  await getApp()
    .db.insert(messages)
    .values({ id, chatId, senderId, format: "markdown", content, metadata, source: "cli" });
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

    const report = await backfillContextDecisionFromNotes(getApp().db, { apply: true, limit: 100 });
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

    const report = await backfillContextDecisionFromNotes(getApp().db, { apply: false, limit: 100 });
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

    const report = await backfillContextDecisionFromNotes(getApp().db, { apply: true, limit: 100 });
    expect(report.scanned).toBe(0);
    expect((await metadataOf(id))[CONTEXT_DECISION_METADATA_KEY]).toEqual(existing);
  });

  it("skips a human sender who merely quoted a note", async () => {
    const seed = await seedChat();
    const id = await insertMessage(seed.chatId, seed.humanAgentUuid, noteBody());

    const report = await backfillContextDecisionFromNotes(getApp().db, { apply: true, limit: 100 });
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

    const report = await backfillContextDecisionFromNotes(getApp().db, { apply: true, limit: 100 });
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
    const absent = await backfillContextDecisionFromNotes(getApp().db, {
      apply: true,
      limit: 100,
      organizationId: `org-${crypto.randomUUID()}`,
    });
    expect(absent.scanned).toBe(0);
    expect(await metadataOf(mine)).toEqual({});

    const scoped = await backfillContextDecisionFromNotes(getApp().db, {
      apply: true,
      limit: 100,
      organizationId: seed.organizationId,
    });
    expect(scoped.tally.derived).toBe(2);
    expect((await metadataOf(mine))[CONTEXT_DECISION_METADATA_KEY]).toBeDefined();
    expect((await metadataOf(theirs))[CONTEXT_DECISION_METADATA_KEY]).toBeDefined();
  });

  it("ignores a body with no note at all", async () => {
    const seed = await seedChat();
    await insertMessage(seed.chatId, seed.agent.uuid, "Shipped the per-org index.");

    expect((await backfillContextDecisionFromNotes(getApp().db, { apply: true, limit: 100 })).scanned).toBe(0);
  });
});
