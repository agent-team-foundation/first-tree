import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { ToolCallEventPayload } from "@agent-team-foundation/first-tree-hub-shared";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { GithubEntity } from "../api/webhooks/github-entity.js";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { githubEntityChatMappings } from "../db/schema/github-entity-chat-mappings.js";
import { maybeBindGithubEntityFromToolCall, resolveTargetChat } from "../services/github-entity-chat.js";
import { appendEvent } from "../services/session-event.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

type App = ReturnType<ReturnType<typeof useTestApp>>;

async function seedAgent(
  app: App,
  opts: {
    orgId: string;
    memberId: string;
    name: string;
    type: "human" | "autonomous_agent";
    status?: "active" | "suspended";
  },
): Promise<string> {
  const uuid = randomUUID();
  await app.db.insert(agents).values({
    uuid,
    name: opts.name,
    organizationId: opts.orgId,
    type: opts.type,
    displayName: opts.name,
    inboxId: `inbox_${uuid}`,
    managerId: opts.memberId,
    status: opts.status ?? "active",
  });
  return uuid;
}

async function seedChat(app: App, orgId: string, type: "direct" | "group", participants: string[]): Promise<string> {
  const id = `chat_${randomUUID()}`;
  await app.db.insert(chats).values({ id, organizationId: orgId, type, metadata: {} });
  await app.db.insert(chatMembership).values(
    participants.map((agentId, idx) => ({
      chatId: id,
      agentId,
      role: idx === 0 ? "owner" : "member",
      accessMode: "speaker" as const,
    })),
  );
  return id;
}

function prCreatePayload(url: string): ToolCallEventPayload {
  return {
    toolUseId: `tu-${randomUUID()}`,
    name: "Bash",
    args: { command: 'gh pr create --title "x" --body "y"' },
    status: "ok",
    resultPreview: url,
  };
}

describe("maybeBindGithubEntityFromToolCall", () => {
  const getApp = useTestApp();

  it("writes a single agent_created mapping for a direct chat (1 human + 1 delegate)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
    });
    const chatId = await seedChat(app, admin.organizationId, "direct", [admin.humanAgentUuid, delegate]);

    await maybeBindGithubEntityFromToolCall(
      app.db,
      delegate,
      chatId,
      prCreatePayload("https://github.com/owner/repo/pull/501"),
    );

    const rows = await app.db
      .select()
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.chatId, chatId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.boundVia).toBe("agent_created");
    expect(rows[0]?.entityType).toBe("pull_request");
    expect(rows[0]?.entityKey).toBe("owner/repo#501");
    expect(rows[0]?.humanAgentId).toBe(admin.humanAgentUuid);
    expect(rows[0]?.delegateAgentId).toBe(delegate);
  });

  it("prefers a human whose delegateMention points at the reporter over id-sorted-first", async () => {
    // Selection order is "delegateMention-linked first, id-sorted fallback".
    // Force the id ordering to disagree with the delegate link: create the
    // linked human AFTER the unlinked one so id-sorted-first would pick the
    // unlinked one. The representative pick must override that with the
    // linked human regardless.
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
    });

    // Build two extra humans, then pick whichever sorts smaller as the
    // unlinked one and the other as the linked one. Guarantees the linked
    // human is NOT id-sorted-first against the unlinked extra.
    const humanA = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `hA-${randomUUID().slice(0, 6)}`,
      type: "human",
    });
    const humanB = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `hB-${randomUUID().slice(0, 6)}`,
      type: "human",
    });
    const [smallerHuman, largerHuman] = humanA < humanB ? [humanA, humanB] : [humanB, humanA];
    // Point the larger-id human at the reporter via delegateMention.
    await app.db.update(agents).set({ delegateMention: delegate }).where(eq(agents.uuid, largerHuman));

    const chatId = await seedChat(app, admin.organizationId, "group", [smallerHuman, largerHuman, delegate]);

    await maybeBindGithubEntityFromToolCall(
      app.db,
      delegate,
      chatId,
      prCreatePayload("https://github.com/owner/repo/pull/506"),
    );

    const rows = await app.db
      .select()
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.chatId, chatId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.humanAgentId).toBe(largerHuman);
  });

  it("writes exactly ONE mapping in a group chat (representative human, no fan-out)", async () => {
    // Without the representative-pick logic, a group with N humans would
    // produce N mapping rows -> N subscribed audience targets on the next
    // webhook -> N duplicate cards delivered to the same chat. The
    // representative-pick keeps that to exactly one row.
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
    });
    const human2 = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `h2-${randomUUID().slice(0, 6)}`,
      type: "human",
    });
    const chatId = await seedChat(app, admin.organizationId, "group", [admin.humanAgentUuid, human2, delegate]);

    await maybeBindGithubEntityFromToolCall(
      app.db,
      delegate,
      chatId,
      prCreatePayload("https://github.com/owner/repo/pull/502"),
    );

    const rows = await app.db
      .select()
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.chatId, chatId));
    expect(rows).toHaveLength(1);
    // Representative is the id-sorted-first active human in the chat.
    const expectedHuman = [admin.humanAgentUuid, human2].sort()[0];
    expect(rows[0]?.humanAgentId).toBe(expectedHuman);
    expect(rows[0]?.delegateAgentId).toBe(delegate);
  });

  it("is idempotent: a repeated tool_call ok event produces no second row", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
    });
    const chatId = await seedChat(app, admin.organizationId, "direct", [admin.humanAgentUuid, delegate]);

    const payload = prCreatePayload("https://github.com/owner/repo/pull/503");
    await maybeBindGithubEntityFromToolCall(app.db, delegate, chatId, payload);
    await maybeBindGithubEntityFromToolCall(app.db, delegate, chatId, payload);

    const rows = await app.db
      .select()
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.chatId, chatId));
    expect(rows).toHaveLength(1);
  });

  it("skips when the reporter is not a member of the chat", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
    });
    const outsider = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `out-${randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
    });
    const chatId = await seedChat(app, admin.organizationId, "direct", [admin.humanAgentUuid, delegate]);

    await maybeBindGithubEntityFromToolCall(
      app.db,
      outsider,
      chatId,
      prCreatePayload("https://github.com/owner/repo/pull/504"),
    );

    const rows = await app.db
      .select()
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.chatId, chatId));
    expect(rows).toHaveLength(0);
  });

  it("skips when the chat has no human members (delegate-only)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegateA = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `a-${randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
    });
    const delegateB = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `b-${randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
    });
    const chatId = await seedChat(app, admin.organizationId, "direct", [delegateA, delegateB]);

    await maybeBindGithubEntityFromToolCall(
      app.db,
      delegateA,
      chatId,
      prCreatePayload("https://github.com/owner/repo/pull/505"),
    );

    const rows = await app.db
      .select()
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.chatId, chatId));
    expect(rows).toHaveLength(0);
  });

  it("no-op when extractor returns null (unrecognised tool / non-creation command)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
    });
    const chatId = await seedChat(app, admin.organizationId, "direct", [admin.humanAgentUuid, delegate]);

    await maybeBindGithubEntityFromToolCall(app.db, delegate, chatId, {
      toolUseId: "tu",
      name: "Bash",
      args: { command: "gh pr list" },
      status: "ok",
      resultPreview: "PR #1 https://github.com/owner/repo/pull/1",
    });

    const rows = await app.db.select().from(githubEntityChatMappings);
    expect(rows.filter((r) => r.chatId === chatId)).toHaveLength(0);
  });
});

describe("resolveTargetChat creation-event guard", () => {
  const getApp = useTestApp();

  function entity(): GithubEntity {
    return {
      type: "pull_request",
      key: `owner/repo#${Math.floor(Math.random() * 100000)}`,
      title: "Guard test",
      url: "https://github.com/owner/repo/pull/0",
    };
  }

  it("returns null on an opened PR webhook when no mapping exists and target is not mention-driven", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
    });

    const result = await resolveTargetChat(app.db, {
      organizationId: admin.organizationId,
      humanAgentId: admin.humanAgentUuid,
      delegateAgentId: delegate,
      entity: entity(),
      relatedEntities: [],
      eventType: "pull_request",
      action: "opened",
      isMentionMatched: false,
    });

    expect(result).toBeNull();
    // No mapping row was written, no chat invented.
    const mappings = await app.db.select().from(githubEntityChatMappings);
    expect(
      mappings.filter((m) => m.humanAgentId === admin.humanAgentUuid && m.delegateAgentId === delegate),
    ).toHaveLength(0);
  });

  it("still creates the chat when target IS mention-driven (default behaviour preserved)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
    });

    const ent = entity();
    const result = await resolveTargetChat(app.db, {
      organizationId: admin.organizationId,
      humanAgentId: admin.humanAgentUuid,
      delegateAgentId: delegate,
      entity: ent,
      relatedEntities: [],
      eventType: "pull_request",
      action: "opened",
      isMentionMatched: true,
    });

    expect(result).not.toBeNull();
    expect(result?.created).toBe(true);
    expect(result?.boundVia).toBe("direct");
  });

  it("non-creation events (e.g. issue_comment.created) never trigger the guard", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
    });

    const result = await resolveTargetChat(app.db, {
      organizationId: admin.organizationId,
      humanAgentId: admin.humanAgentUuid,
      delegateAgentId: delegate,
      entity: entity(),
      relatedEntities: [],
      eventType: "issue_comment",
      action: "created",
      isMentionMatched: false,
    });

    // Guard didn't fire because the event isn't a creation event — falls
    // through to (c) which mints the chat.
    expect(result).not.toBeNull();
    expect(result?.created).toBe(true);
  });

  it("PR comments on an agent_created entity route back to the original chat (end-to-end)", async () => {
    // The whole point of the agent_created mapping. We pre-write the mapping
    // (as `maybeBindGithubEntityFromToolCall` would on tool_call ok) and
    // assert resolveTargetChat returns the same chat for a downstream comment.
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
    });
    const chatId = await seedChat(app, admin.organizationId, "direct", [admin.humanAgentUuid, delegate]);
    await maybeBindGithubEntityFromToolCall(
      app.db,
      delegate,
      chatId,
      prCreatePayload("https://github.com/owner/repo/pull/707"),
    );

    const result = await resolveTargetChat(app.db, {
      organizationId: admin.organizationId,
      humanAgentId: admin.humanAgentUuid,
      delegateAgentId: delegate,
      entity: {
        type: "pull_request",
        key: "owner/repo#707",
        url: "https://github.com/owner/repo/pull/707",
      },
      relatedEntities: [],
      eventType: "issue_comment",
      action: "created",
      isMentionMatched: false,
    });

    expect(result?.chatId).toBe(chatId);
    expect(result?.created).toBe(false);
    expect(result?.boundVia).toBe("agent_created");

    // Same mapping is reused; no extra rows.
    const all = await app.db
      .select()
      .from(githubEntityChatMappings)
      .where(
        and(
          eq(githubEntityChatMappings.entityType, "pull_request"),
          eq(githubEntityChatMappings.entityKey, "owner/repo#707"),
        ),
      );
    expect(all).toHaveLength(1);
  });
});

describe("appendEvent → agent_created binding hook", () => {
  const getApp = useTestApp();

  async function waitForMapping(
    app: ReturnType<ReturnType<typeof useTestApp>>,
    chatId: string,
    timeoutMs = 2000,
  ): Promise<Array<{ boundVia: string; entityKey: string }>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const rows = await app.db
        .select({
          boundVia: githubEntityChatMappings.boundVia,
          entityKey: githubEntityChatMappings.entityKey,
        })
        .from(githubEntityChatMappings)
        .where(eq(githubEntityChatMappings.chatId, chatId));
      if (rows.length > 0) return rows;
      await sleep(25);
    }
    return [];
  }

  it("writes a mapping when a tool_call ok event flows through appendEvent", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
    });
    const chatId = await seedChat(app, admin.organizationId, "direct", [admin.humanAgentUuid, delegate]);

    await appendEvent(app.db, delegate, chatId, {
      kind: "tool_call",
      payload: prCreatePayload("https://github.com/owner/repo/pull/801"),
    });

    const rows = await waitForMapping(app, chatId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.boundVia).toBe("agent_created");
    expect(rows[0]?.entityKey).toBe("owner/repo#801");
  });

  it("does NOT trigger the binding hook for pending tool_call events", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
    });
    const chatId = await seedChat(app, admin.organizationId, "direct", [admin.humanAgentUuid, delegate]);

    await appendEvent(app.db, delegate, chatId, {
      kind: "tool_call",
      payload: {
        toolUseId: "tu-pending",
        name: "Bash",
        args: { command: "gh pr create" },
        status: "pending",
      },
    });

    // Give any (incorrectly fired) side-effect a chance to land.
    await sleep(150);

    const rows = await app.db
      .select()
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.chatId, chatId));
    expect(rows).toHaveLength(0);
  });

  it("appendEvent succeeds even if the binding side-effect fails (fire-and-forget isolation)", async () => {
    // Simulate the chat going away between INSERT session_events and the
    // bookkeeping side-effect by using a chatId with no membership rows. The
    // side-effect's resolveBindingPair returns null and logs at debug; the
    // main appendEvent return value must still reflect a successful insert.
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
    });
    const orphanChatId = `chat_${randomUUID()}`;
    await app.db
      .insert(chats)
      .values({ id: orphanChatId, organizationId: admin.organizationId, type: "direct", metadata: {} });

    const persisted = await appendEvent(app.db, delegate, orphanChatId, {
      kind: "tool_call",
      payload: prCreatePayload("https://github.com/owner/repo/pull/802"),
    });

    expect(persisted.seq).toBe(1);
    expect(persisted.kind).toBe("tool_call");
    await sleep(150);
    const rows = await app.db
      .select()
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.chatId, orphanChatId));
    expect(rows).toHaveLength(0);
  });
});
