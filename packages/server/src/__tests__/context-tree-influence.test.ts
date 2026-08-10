import { CONTEXT_DECISION_METADATA_KEY, type ContextDecision } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { messages } from "../db/schema/messages.js";
import { organizations } from "../db/schema/organizations.js";
import { summarizeContextTreeInfluence } from "../services/context-tree/influence.js";
import { createTestAgent, useTestApp } from "./helpers.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const REPO = "https://github.com/acme/first-tree-context";
const TENANCY = "system/cloud/team/tenancy-and-identity.md";
const GATES = "operations/release/safety-gates.md";

const getApp = useTestApp();

function receipt(overrides: Partial<ContextDecision> = {}): ContextDecision {
  return {
    version: 1,
    effect: "constrained",
    summary: "The organization-isolation rule ruled out a global shared index.",
    evidence: [{ repoUrl: REPO, commit: COMMIT, nodePath: TENANCY, heading: "Organization isolation" }],
    ...overrides,
  };
}

async function seedChat(topic = "Resource layer") {
  const app = getApp();
  const seed = await createTestAgent(app);
  const chatId = `chat-${crypto.randomUUID()}`;
  await app.db.insert(chats).values({ id: chatId, organizationId: seed.organizationId, type: "direct", topic });
  return { ...seed, chatId };
}

async function sendMessage(
  chatId: string,
  senderId: string,
  metadata: Record<string, unknown>,
  createdAt = new Date(),
): Promise<string> {
  const app = getApp();
  const id = `msg-${crypto.randomUUID()}`;
  await app.db.insert(messages).values({
    id,
    chatId,
    senderId,
    format: "markdown",
    content: "Keeping the index per organization.",
    metadata,
    source: "cli",
    createdAt,
  });
  return id;
}

describe("context-tree influence summary", () => {
  it("reports nothing when the window holds no receipts", async () => {
    const seed = await seedChat();
    await sendMessage(seed.chatId, seed.agent.uuid, {});

    const summary = await summarizeContextTreeInfluence(getApp().db, seed.organizationId, 7);
    expect(summary).toEqual({
      windowDays: 7,
      decisionCount: 0,
      effects: { conflicted: 0, redirected: 0, constrained: 0, confirmed: 0 },
      nodes: [],
      recentEvents: [],
    });
  });

  it("counts decisions and tallies each effect", async () => {
    const seed = await seedChat();
    await sendMessage(seed.chatId, seed.agent.uuid, { [CONTEXT_DECISION_METADATA_KEY]: receipt() });
    await sendMessage(seed.chatId, seed.agent.uuid, {
      [CONTEXT_DECISION_METADATA_KEY]: receipt({ effect: "conflicted" }),
    });
    await sendMessage(seed.chatId, seed.agent.uuid, {
      [CONTEXT_DECISION_METADATA_KEY]: receipt({ effect: "conflicted" }),
    });

    const summary = await summarizeContextTreeInfluence(getApp().db, seed.organizationId, 7);
    expect(summary.decisionCount).toBe(3);
    expect(summary.effects).toEqual({ conflicted: 2, redirected: 0, constrained: 1, confirmed: 0 });
  });

  // One answer citing three nodes is one decision the Tree shaped, not three.
  it("counts a multi-node citation as one decision but ranks each node", async () => {
    const seed = await seedChat();
    await sendMessage(seed.chatId, seed.agent.uuid, {
      [CONTEXT_DECISION_METADATA_KEY]: receipt({
        evidence: [
          { repoUrl: REPO, commit: COMMIT, nodePath: TENANCY, heading: "Organization isolation" },
          { repoUrl: REPO, commit: COMMIT, nodePath: GATES, heading: "Release gates" },
        ],
      }),
    });
    await sendMessage(seed.chatId, seed.agent.uuid, { [CONTEXT_DECISION_METADATA_KEY]: receipt() });

    const summary = await summarizeContextTreeInfluence(getApp().db, seed.organizationId, 7);
    expect(summary.decisionCount).toBe(2);
    expect(summary.nodes).toEqual([
      { nodePath: TENANCY, title: "Organization isolation", repoUrl: REPO, commit: COMMIT, decisionCount: 2 },
      { nodePath: GATES, title: "Release gates", repoUrl: REPO, commit: COMMIT, decisionCount: 1 },
    ]);
  });

  it("falls back to the file name when a citation carries no heading", async () => {
    const seed = await seedChat();
    await sendMessage(seed.chatId, seed.agent.uuid, {
      [CONTEXT_DECISION_METADATA_KEY]: receipt({
        evidence: [{ repoUrl: REPO, commit: COMMIT, nodePath: TENANCY }],
      }),
    });

    const summary = await summarizeContextTreeInfluence(getApp().db, seed.organizationId, 7);
    expect(summary.nodes[0]?.title).toBe("tenancy-and-identity.md");
  });

  it("excludes receipts older than the window", async () => {
    const seed = await seedChat();
    const stale = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await sendMessage(seed.chatId, seed.agent.uuid, { [CONTEXT_DECISION_METADATA_KEY]: receipt() }, stale);

    const summary = await summarizeContextTreeInfluence(getApp().db, seed.organizationId, 7);
    expect(summary.decisionCount).toBe(0);
  });

  it("excludes receipts belonging to another organization", async () => {
    const app = getApp();
    const seed = await seedChat();
    const otherOrgId = `org-${crypto.randomUUID()}`;
    await app.db.insert(organizations).values({ id: otherOrgId, name: otherOrgId, displayName: "Other org" });
    const otherChatId = `chat-${crypto.randomUUID()}`;
    await app.db
      .insert(chats)
      .values({ id: otherChatId, organizationId: otherOrgId, type: "direct", topic: "elsewhere" });
    await sendMessage(otherChatId, seed.agent.uuid, { [CONTEXT_DECISION_METADATA_KEY]: receipt() });

    expect((await summarizeContextTreeInfluence(app.db, seed.organizationId, 7)).decisionCount).toBe(0);
    expect((await summarizeContextTreeInfluence(app.db, otherOrgId, 7)).decisionCount).toBe(1);
  });

  // Message rows are immutable, so history written before a guard existed is
  // never re-validated. A junk receipt must not inflate the headline — and a
  // non-array `evidence` must not blow up the node ranking's LATERAL unnest.
  it("ignores stored receipts with a bad effect or a non-array evidence", async () => {
    const seed = await seedChat();
    await sendMessage(seed.chatId, seed.agent.uuid, {
      [CONTEXT_DECISION_METADATA_KEY]: { ...receipt(), effect: "none" },
    });
    await sendMessage(seed.chatId, seed.agent.uuid, {
      [CONTEXT_DECISION_METADATA_KEY]: { ...receipt(), evidence: "system/cloud/team/tenancy-and-identity.md" },
    });
    await sendMessage(seed.chatId, seed.agent.uuid, { [CONTEXT_DECISION_METADATA_KEY]: "constrained" });

    const summary = await summarizeContextTreeInfluence(getApp().db, seed.organizationId, 7);
    expect(summary.decisionCount).toBe(0);
    expect(summary.nodes).toEqual([]);
  });

  it("carries the chat topic and the decision through to the feed", async () => {
    const seed = await seedChat("Release cut");
    const messageId = await sendMessage(seed.chatId, seed.agent.uuid, {
      [CONTEXT_DECISION_METADATA_KEY]: receipt({
        effect: "conflicted",
        summary: "Two release rules cannot both hold.",
      }),
    });

    const summary = await summarizeContextTreeInfluence(getApp().db, seed.organizationId, 7);
    expect(summary.recentEvents).toHaveLength(1);
    expect(summary.recentEvents[0]).toMatchObject({
      id: messageId,
      agentId: seed.agent.uuid,
      chatId: seed.chatId,
      chatTitle: "Release cut",
      effect: "conflicted",
      summary: "Two release rules cannot both hold.",
      viewerCanAccess: false,
    });
    expect(summary.recentEvents[0]?.evidence[0]?.nodePath).toBe(TENANCY);
  });

  // The topic stays org-wide visible; only a viewer who passes the same
  // membership rule as requireChatAccess gets a clickable link.
  it("marks a chat accessible only for a viewer who may open it", async () => {
    const app = getApp();
    const seed = await seedChat();
    await sendMessage(seed.chatId, seed.agent.uuid, { [CONTEXT_DECISION_METADATA_KEY]: receipt() });

    const outsider = await summarizeContextTreeInfluence(app.db, seed.organizationId, 7, {
      humanAgentId: `human-${crypto.randomUUID()}`,
      memberId: `member-${crypto.randomUUID()}`,
    });
    expect(outsider.recentEvents[0]?.viewerCanAccess).toBe(false);

    await app.db
      .insert(chatMembership)
      .values({ chatId: seed.chatId, agentId: seed.humanAgentUuid, accessMode: "speaker" });
    const member = await summarizeContextTreeInfluence(app.db, seed.organizationId, 7, {
      humanAgentId: seed.humanAgentUuid,
      memberId: seed.memberId,
    });
    expect(member.recentEvents[0]?.viewerCanAccess).toBe(true);
  });
});
