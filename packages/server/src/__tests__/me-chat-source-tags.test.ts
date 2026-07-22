/**
 * Origin-tag projection for the conversation-list left rail.
 *
 * Pins two pieces of behavior:
 *
 *   1. `listMeChats({ origin })` filters down to one or more ChatSource
 *      values — `manual` / `github` / `agent` — by inspecting `chats.metadata`
 *      (no schema migration; the field already existed and was only
 *      written by the github-entity-chat path). Phase C collapsed the
 *      GitHub entity types (PR / Issue / Discussion / Commit) into a
 *      single `github` origin; the per-entity granularity lives on
 *      `MeChatRow.entityType` (drives the leading icon, not the filter
 *      dimension).
 *
 *   2. `listMeChatSourceCounts` returns one row per source the caller has
 *      at least one chat in, plus an always-present `manual` row, so the
 *      web filter popover can render badges (and hide options whose
 *      chatCount is 0).
 *
 * The seeding here goes around `createMeChat` because that helper writes
 * `metadata: '{}'` — to exercise the github arm we need to plant the same
 * shape the entity-chat resolver persists. The participant rows still go
 * through `addChatParticipants` so membership stays consistent with the
 * production path.
 */

import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { chatUserState } from "../db/schema/chat-user-state.js";
import { chats } from "../db/schema/chats.js";
import { createAgent } from "../services/agent.js";
import { listMeChatSourceCounts, listMeChats } from "../services/me-chat.js";
import { addChatParticipants } from "../services/participant-mode.js";
import { uuidv7 } from "../uuid.js";
import { createTestAdmin, TEST_AVATAR_AUTHORITY_TAG, useTestApp } from "./helpers.js";

type SeedSpec = {
  metadata: Record<string, unknown>;
  topic: string;
};

describe("conversation-list source tags", () => {
  const getApp = useTestApp();

  /**
   * Seed N chats in the admin's org, with the requested metadata shapes.
   * Each chat has the admin's human agent and a freshly-minted same-org peer
   * human as speakers — using a fresh peer per chat sidesteps the direct-chat
   * dedupe-by-pair invariant for multi-chat-with-same-peer cases.
   *
   * Returns a tuple typed by the input length so destructured chat-ids are
   * `string` (not `string | undefined`) at the call site.
   */
  async function seedChats<const Specs extends ReadonlyArray<SeedSpec>>(
    app: FastifyInstance,
    orgId: string,
    memberId: string,
    humanAgentId: string,
    specs: Specs,
  ): Promise<{ -readonly [K in keyof Specs]: string }> {
    const ids: string[] = [];
    for (const spec of specs) {
      const peer = await createAgent(app.db, {
        name: `src-peer-${crypto.randomUUID().slice(0, 8)}`,
        type: "human",
        displayName: "Source Tag Peer",
        managerId: memberId,
        organizationId: orgId,
      });
      const chatId = uuidv7();
      await app.db.transaction(async (tx) => {
        await tx.insert(chats).values({
          id: chatId,
          organizationId: orgId,
          type: "direct",
          topic: spec.topic,
          metadata: spec.metadata,
        });
        await addChatParticipants(tx, chatId, [
          { agentId: humanAgentId, role: "owner" },
          { agentId: peer.uuid, role: "member" },
        ]);
      });
      ids.push(chatId);
    }
    // The for-loop above pushes exactly one id per input spec, so the array
    // has the same length and order as `specs` — the tuple-cast is safe.
    return ids as { -readonly [K in keyof Specs]: string };
  }

  it("listMeChats filters by source.manual / github / agent", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    const [manualChatId, issueChatId, prChatId, agentChatId] = await seedChats(
      app,
      admin.organizationId,
      admin.memberId,
      admin.humanAgentUuid,
      [
        { metadata: {}, topic: "manual chat" },
        {
          metadata: { source: "github", entityType: "issue", entityKey: "owner/repo#1" },
          topic: "issue chat",
        },
        {
          metadata: { source: "github", entityType: "pull_request", entityKey: "owner/repo#2" },
          topic: "pr chat",
        },
        {
          metadata: { source: "agent", initiatedByAgentId: "agent-self" },
          topic: "agent-created task chat",
        },
      ],
    );

    // Default (no source param) returns all chats across sources.
    const all = await listMeChats(
      app.db,
      admin.humanAgentUuid,
      admin.memberId,
      admin.organizationId,
      {
        limit: 50,
        filter: "all",
        engagement: "active",
      },
      TEST_AVATAR_AUTHORITY_TAG,
    );
    expect(all.rows.map((r) => r.chatId).sort()).toEqual([manualChatId, issueChatId, prChatId, agentChatId].sort());

    // manual: must NOT leak github chats — that was the regression
    // risk when this filter was first wired.
    const manualOnly = await listMeChats(
      app.db,
      admin.humanAgentUuid,
      admin.memberId,
      admin.organizationId,
      {
        limit: 50,
        filter: "all",
        engagement: "active",
        origin: ["manual"],
      },
      TEST_AVATAR_AUTHORITY_TAG,
    );
    expect(manualOnly.rows.map((r) => r.chatId)).toEqual([manualChatId]);

    // origin collapses PR + Issue into a single `github` bucket — the
    // per-entity granularity now rides on `row.entityType` for the
    // leading-icon renderer, not on the filter dimension.
    const githubOnly = await listMeChats(
      app.db,
      admin.humanAgentUuid,
      admin.memberId,
      admin.organizationId,
      {
        limit: 50,
        filter: "all",
        engagement: "active",
        origin: ["github"],
      },
      TEST_AVATAR_AUTHORITY_TAG,
    );
    expect(githubOnly.rows.map((r) => r.chatId).sort()).toEqual([issueChatId, prChatId].sort());

    // `entityType` is projected from `chats.metadata->>'entityType'`
    // so the PR vs Issue distinction survives the origin collapse.
    const prRow = githubOnly.rows.find((r) => r.chatId === prChatId);
    const issueRow = githubOnly.rows.find((r) => r.chatId === issueChatId);
    expect(prRow?.entityType).toBe("pull_request");
    expect(issueRow?.entityType).toBe("issue");

    const agentOnly = await listMeChats(
      app.db,
      admin.humanAgentUuid,
      admin.memberId,
      admin.organizationId,
      {
        limit: 50,
        filter: "all",
        engagement: "active",
        origin: ["agent"],
      },
      TEST_AVATAR_AUTHORITY_TAG,
    );
    expect(agentOnly.rows.map((r) => r.chatId)).toEqual([agentChatId]);
    expect(agentOnly.rows[0]?.source).toBe("agent");
    expect(agentOnly.rows[0]?.entityType).toBeNull();

    const manualAndGithub = await listMeChats(
      app.db,
      admin.humanAgentUuid,
      admin.memberId,
      admin.organizationId,
      {
        limit: 50,
        filter: "all",
        engagement: "active",
        origin: ["manual", "github", "github"],
      },
      TEST_AVATAR_AUTHORITY_TAG,
    );
    expect(manualAndGithub.rows.map((r) => r.chatId).sort()).toEqual([manualChatId, issueChatId, prChatId].sort());
  });

  it("projects createdByMe from the caller's chat membership role", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createAgent(app.db, {
      name: `owner-peer-${crypto.randomUUID().slice(0, 8)}`,
      type: "human",
      displayName: "Owner Peer",
      managerId: admin.memberId,
      organizationId: admin.organizationId,
    });

    const ownedByMe = uuidv7();
    const ownedByPeer = uuidv7();
    await app.db.transaction(async (tx) => {
      await tx.insert(chats).values([
        {
          id: ownedByMe,
          organizationId: admin.organizationId,
          type: "direct",
          topic: "owned by me",
          metadata: {},
        },
        {
          id: ownedByPeer,
          organizationId: admin.organizationId,
          type: "direct",
          topic: "owned by peer",
          metadata: {},
        },
      ]);
      await addChatParticipants(tx, ownedByMe, [
        { agentId: admin.humanAgentUuid, role: "owner" },
        { agentId: peer.uuid, role: "member" },
      ]);
      await addChatParticipants(tx, ownedByPeer, [
        { agentId: peer.uuid, role: "owner" },
        { agentId: admin.humanAgentUuid, role: "member" },
      ]);
    });

    const rows = await listMeChats(
      app.db,
      admin.humanAgentUuid,
      admin.memberId,
      admin.organizationId,
      {
        limit: 50,
        filter: "all",
        engagement: "active",
      },
      TEST_AVATAR_AUTHORITY_TAG,
    );
    const byId = new Map(rows.rows.map((r) => [r.chatId, r.createdByMe]));
    expect(byId.get(ownedByMe)).toBe(true);
    expect(byId.get(ownedByPeer)).toBe(false);
  });

  it("listMeChatSourceCounts: chatCount + unreadChatCount, manual always present", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    const [, , prA, prB, , agentTask] = await seedChats(
      app,
      admin.organizationId,
      admin.memberId,
      admin.humanAgentUuid,
      [
        { metadata: {}, topic: "m1" },
        { metadata: {}, topic: "m2" },
        {
          metadata: { source: "github", entityType: "pull_request", entityKey: "o/r#10" },
          topic: "pr1",
        },
        {
          metadata: { source: "github", entityType: "pull_request", entityKey: "o/r#11" },
          topic: "pr2",
        },
        {
          metadata: { source: "github", entityType: "issue", entityKey: "o/r#12" },
          topic: "is1",
        },
        {
          metadata: { source: "agent", initiatedByAgentId: "agent-self" },
          topic: "agent-task",
        },
      ],
    );

    // Plant unread mentions on TWO PR chats with different counts.
    // `unreadChatCount` is the count of unread chats (semantics match the
    // existing `unread` pill), NOT the sum of mention counts — verify by
    // setting unequal values and asserting the badge reads 2, not 4.
    await app.db.insert(chatUserState).values([
      { chatId: prA, agentId: admin.humanAgentUuid, unreadMentionCount: 1 },
      { chatId: prB, agentId: admin.humanAgentUuid, unreadMentionCount: 3 },
      { chatId: agentTask, agentId: admin.humanAgentUuid, unreadMentionCount: 2 },
    ]);

    const { counts } = await listMeChatSourceCounts(app.db, admin.humanAgentUuid, admin.organizationId, {
      engagement: "active",
    });

    expect(counts.manual).toEqual({ chatCount: 2, unreadChatCount: 0 });
    // Phase C: `origin` now collapses every github entity type into a
    // single `github` bucket. Two PRs (both unread) + one Issue (read)
    // all count under `github` — 3 chats, 2 unread.
    expect(counts.github).toEqual({ chatCount: 3, unreadChatCount: 2 });
    expect(counts.agent).toEqual({ chatCount: 1, unreadChatCount: 1 });
  });

  it("listMeChatSourceCounts: empty workspace still surfaces manual at zero", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    const { counts } = await listMeChatSourceCounts(app.db, admin.humanAgentUuid, admin.organizationId, {
      engagement: "active",
    });

    expect(counts.manual).toEqual({ chatCount: 0, unreadChatCount: 0 });
    expect(counts.github).toBeUndefined();
  });

  /**
   * Future-proofing: a malformed github row (recognised `source` but an
   * `entityType` we don't yet have a tag for, or a writer that wrote
   * `source` and skipped `entityType` entirely) must bucket consistently
   * across the aggregate and the per-tab filter. Counts say "manual: 1",
   * clicking Manual must surface the same chat — otherwise the badge
   * appears to lie.
   */
  it("github metadata with an unknown entityType still buckets under github", async () => {
    // Phase C: origin collapses on the `source` discriminator alone,
    // so any `source: "github"` row is `github` regardless of inner
    // entityType. The unfamiliar entityType decays to `null` on
    // `row.entityType` (the leading-icon renderer falls back to a
    // generic glyph). Previously this fell into `manual` because the
    // pre-collapse CASE matched on `(source, entityType)` pairs.
    const app = getApp();
    const admin = await createTestAdmin(app);
    const [futureChatId] = await seedChats(app, admin.organizationId, admin.memberId, admin.humanAgentUuid, [
      {
        metadata: { source: "github", entityType: "release", entityKey: "o/r@v1" },
        topic: "future-entity-type",
      },
    ]);

    const { counts } = await listMeChatSourceCounts(app.db, admin.humanAgentUuid, admin.organizationId, {
      engagement: "active",
    });
    expect(counts.github).toEqual({ chatCount: 1, unreadChatCount: 0 });
    expect(counts.manual).toEqual({ chatCount: 0, unreadChatCount: 0 });

    const list = await listMeChats(
      app.db,
      admin.humanAgentUuid,
      admin.memberId,
      admin.organizationId,
      {
        limit: 50,
        filter: "all",
        engagement: "active",
        origin: ["github"],
      },
      TEST_AVATAR_AUTHORITY_TAG,
    );
    expect(list.rows.map((r) => r.chatId)).toEqual([futureChatId]);
    // Unknown entityType narrows to null on the row — known values
    // (`pull_request` etc.) flow through; "release" doesn't.
    expect(list.rows[0]?.entityType).toBeNull();
  });

  /**
   * Origin filter composes with `filter=unread` — neither swallows the
   * other. Two PRs (one unread, one read) + one unread Issue: filtering
   * to `origin=github` AND `filter=unread` returns the unread PR + the
   * unread Issue (both are `github` after the Phase C collapse).
   */
  it("origin filter composes with filter=unread", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const [, prUnread, issueUnread] = await seedChats(app, admin.organizationId, admin.memberId, admin.humanAgentUuid, [
      {
        metadata: { source: "github", entityType: "pull_request", entityKey: "o/r#20" },
        topic: "pr-read",
      },
      {
        metadata: { source: "github", entityType: "pull_request", entityKey: "o/r#21" },
        topic: "pr-unread",
      },
      {
        metadata: { source: "github", entityType: "issue", entityKey: "o/r#22" },
        topic: "issue-unread",
      },
    ]);

    await app.db.insert(chatUserState).values([
      { chatId: prUnread, agentId: admin.humanAgentUuid, unreadMentionCount: 1 },
      { chatId: issueUnread, agentId: admin.humanAgentUuid, unreadMentionCount: 1 },
    ]);

    const res = await listMeChats(
      app.db,
      admin.humanAgentUuid,
      admin.memberId,
      admin.organizationId,
      {
        limit: 50,
        filter: "unread",
        engagement: "active",
        origin: ["github"],
      },
      TEST_AVATAR_AUTHORITY_TAG,
    );
    expect(res.rows.map((r) => r.chatId).sort()).toEqual([prUnread, issueUnread].sort());
  });

  it("source filter respects engagement view (archived chat hidden from active source counts)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const [prChatId] = await seedChats(app, admin.organizationId, admin.memberId, admin.humanAgentUuid, [
      {
        metadata: { source: "github", entityType: "pull_request", entityKey: "o/r#99" },
        topic: "pr-archived",
      },
    ]);

    // Archive the PR chat for this caller (matches what `setChatEngagement`
    // does — a row in chat_user_state with the archived status).
    await app.db
      .insert(chatUserState)
      .values({
        chatId: prChatId,
        agentId: admin.humanAgentUuid,
        unreadMentionCount: 0,
        engagementStatus: "archived",
      })
      .onConflictDoUpdate({
        target: [chatUserState.chatId, chatUserState.agentId],
        set: { engagementStatus: "archived" },
      });

    const activeCounts = await listMeChatSourceCounts(app.db, admin.humanAgentUuid, admin.organizationId, {
      engagement: "active",
    });
    // Archived in `active` view → PR row is hidden, only manual at zero remains.
    expect(activeCounts.counts.github).toBeUndefined();
    expect(activeCounts.counts.manual).toEqual({ chatCount: 0, unreadChatCount: 0 });

    const archivedCounts = await listMeChatSourceCounts(app.db, admin.humanAgentUuid, admin.organizationId, {
      engagement: "archived",
    });
    expect(archivedCounts.counts.github).toEqual({ chatCount: 1, unreadChatCount: 0 });

    // Sanity: the list query mirrors the same engagement view.
    const archivedList = await listMeChats(
      app.db,
      admin.humanAgentUuid,
      admin.memberId,
      admin.organizationId,
      {
        limit: 50,
        filter: "all",
        engagement: "archived",
        origin: ["github"],
      },
      TEST_AVATAR_AUTHORITY_TAG,
    );
    expect(archivedList.rows.map((r) => r.chatId)).toEqual([prChatId]);
  });

  /**
   * Watcher rows participate in `listMeChats` (a manager who supervises a
   * non-human participant sees the chat as `membershipKind: 'watching'`), so
   * the source tag bar must include them in both the per-tab list and the
   * per-source count — otherwise a manager's PR-tag badge could disappear
   * while the chat is still reachable via `?filter=watching`.
   */
  it("watcher rows count toward source counts and surface in source-filtered list", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    // A non-human agent that admin manages; another human (peer) creates
    // the PR chat with that managed agent. The result: admin gets a
    // watcher row on the chat (no speaker grant), mirroring the
    // github-entity-chat resolver's behavior for non-direct managers.
    const { createAgent } = await import("../services/agent.js");
    const managed = await createAgent(app.db, {
      name: `mgr-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Managed Agent",
      managerId: admin.memberId,
      organizationId: admin.organizationId,
      clientId: undefined,
    });
    const peer = await createAgent(app.db, {
      name: `peer-${crypto.randomUUID().slice(0, 6)}`,
      type: "human",
      displayName: "Peer Human",
      managerId: admin.memberId,
      organizationId: admin.organizationId,
    });

    const chatId = uuidv7();
    const { recomputeChatWatchers } = await import("../services/watcher.js");
    await app.db.transaction(async (tx) => {
      await tx.insert(chats).values({
        id: chatId,
        organizationId: admin.organizationId,
        type: "direct",
        topic: "watcher-pr",
        metadata: { source: "github", entityType: "pull_request", entityKey: "o/r#watch" },
      });
      await addChatParticipants(tx, chatId, [
        { agentId: peer.uuid, role: "owner" },
        { agentId: managed.uuid, role: "member" },
      ]);
      await recomputeChatWatchers(tx, chatId);
    });

    // Admin watches via `managed`, so the PR chat appears in counts.
    const { counts } = await listMeChatSourceCounts(app.db, admin.humanAgentUuid, admin.organizationId, {
      engagement: "active",
    });
    expect(counts.github).toEqual({ chatCount: 1, unreadChatCount: 0 });

    // Filtering by origin AND `watching=true` surfaces the watcher row.
    // Phase B lifted `watching` out of the filter enum into an
    // independent boolean — the two now compose freely.
    const watchingPr = await listMeChats(
      app.db,
      admin.humanAgentUuid,
      admin.memberId,
      admin.organizationId,
      {
        limit: 50,
        filter: "all",
        engagement: "active",
        origin: ["github"],
        watching: true,
      },
      TEST_AVATAR_AUTHORITY_TAG,
    );
    expect(watchingPr.rows.map((r) => r.chatId)).toEqual([chatId]);
    expect(watchingPr.rows[0]?.membershipKind).toBe("watching");
    // Sub-type still rides on the row — popover collapse is per-origin,
    // not per-entity.
    expect(watchingPr.rows[0]?.entityType).toBe("pull_request");
  });
});
