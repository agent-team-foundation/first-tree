import { CONTEXT_DECISION_METADATA_KEY, type ContextDecision } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { messages } from "../db/schema/messages.js";
import { organizations } from "../db/schema/organizations.js";
import { snapshotNodePaths, summarizeContextTreeInfluence } from "../services/context-tree/influence.js";
import { createTestAgent, useTestApp } from "./helpers.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const REPO = "https://github.com/acme/first-tree-context";
const TENANCY = "system/cloud/team/tenancy-and-identity.md";
const GATES = "operations/release/safety-gates.md";

const getApp = useTestApp();

// Every summarize call must be scoped to a bound repository — an unscoped
// ranking would merge nodes from other repositories that share a path.
// The ranking only echoes back paths the snapshot carries, so every call
// declares what this Team's snapshot knows.
const KNOWN_PATHS: ReadonlySet<string> = new Set([TENANCY, GATES]);

function summarize(organizationId: string, overrides: Record<string, unknown> = {}) {
  return summarizeContextTreeInfluence(getApp().db, organizationId, 7, {
    boundRepoUrl: REPO,
    knownNodePaths: KNOWN_PATHS,
    ...overrides,
  });
}

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

    const summary = await summarize(seed.organizationId);
    expect(summary).toEqual({
      windowDays: 7,
      decisionCount: 0,
      effects: { conflicted: 0, redirected: 0, constrained: 0, confirmed: 0 },
      nodes: [],
      recentEvents: [],
      truncated: false,
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

    const summary = await summarize(seed.organizationId);
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

    const summary = await summarize(seed.organizationId);
    expect(summary.decisionCount).toBe(2);
    expect(summary.nodes).toEqual([
      { nodePath: TENANCY, decisionCount: 2 },
      { nodePath: GATES, decisionCount: 1 },
    ]);
  });

  // The ranking is org-wide, so it must carry no field only a chat participant
  // should see. A citation's heading is the agent's own wording inside a
  // private body; the client resolves a title from the tree snapshot instead.
  // Everything in a receipt is asserted by a private message body and never
  // verified. A note in a chat the viewer cannot open could name an arbitrary
  // same-repo path and an arbitrary commit; neither may reach an org-wide
  // surface, so the ranking echoes back only paths the snapshot itself carries.
  it("never exposes unverified citation identity through the org-wide ranking", async () => {
    const seed = await seedChat();
    const secretCommit = "f".repeat(40);
    await sendMessage(seed.chatId, seed.agent.uuid, {
      [CONTEXT_DECISION_METADATA_KEY]: receipt({
        evidence: [
          { repoUrl: REPO, commit: secretCommit, nodePath: "customers/SECRET.md", heading: "SECRET LABEL" },
          { repoUrl: REPO, commit: secretCommit, nodePath: TENANCY, heading: "ALSO SECRET" },
        ],
      }),
    });

    const outsider = await summarize(seed.organizationId, {
      viewer: { humanAgentId: `human-${crypto.randomUUID()}`, memberId: `member-${crypto.randomUUID()}` },
    });
    const serialized = JSON.stringify(outsider);
    for (const secret of ["SECRET LABEL", "ALSO SECRET", "customers/SECRET.md", secretCommit]) {
      expect(serialized).not.toContain(secret);
    }
    expect(outsider.nodes).toEqual([{ nodePath: TENANCY, decisionCount: 1 }]);
  });

  // `node.path` is a logical navigation identity, not a file. A directory node
  // sourced at `.../NODE.md` must not allowlist a fabricated `.../<dir>.md`,
  // which would then be counted AND linked to a file that does not exist.
  it("allowlists only exact snapshot source files, never a derived directory path", () => {
    const known = snapshotNodePaths([
      { sourcePath: "system/cloud/context-tree/NODE.md" },
      { sourcePath: "/members/yzw/notebook.md" },
      { sourcePath: null },
    ]);
    expect(known.has("system/cloud/context-tree/NODE.md")).toBe(true);
    expect(known.has("members/yzw/notebook.md")).toBe(true);
    expect(known.has("system/cloud/context-tree.md")).toBe(false);
    expect(known.has("system/cloud/context-tree")).toBe(false);
  });

  it("rejects a fabricated directory citation while accepting its real source", async () => {
    const seed = await seedChat();
    const real = "system/cloud/context-tree/NODE.md";
    const fabricated = "system/cloud/context-tree.md";
    await sendMessage(seed.chatId, seed.agent.uuid, {
      [CONTEXT_DECISION_METADATA_KEY]: receipt({
        evidence: [{ repoUrl: REPO, commit: COMMIT, nodePath: fabricated }],
      }),
    });
    await sendMessage(seed.chatId, seed.agent.uuid, {
      [CONTEXT_DECISION_METADATA_KEY]: receipt({ evidence: [{ repoUrl: REPO, commit: COMMIT, nodePath: real }] }),
    });

    const summary = await summarize(seed.organizationId, {
      knownNodePaths: snapshotNodePaths([{ sourcePath: real }]),
    });
    expect(summary.nodes).toEqual([{ nodePath: real, decisionCount: 1 }]);
  });

  // One node must never split into two ranked rows. Two guarantees combine:
  // the receipt schema already refuses a leading-slash `nodePath`, and the
  // allowlist now holds exactly one form per node — so a citation either
  // matches that one string or is dropped.
  it("aggregates repeated citations of one node into a single row", async () => {
    const seed = await seedChat();
    await sendMessage(seed.chatId, seed.agent.uuid, { [CONTEXT_DECISION_METADATA_KEY]: receipt() });
    await sendMessage(seed.chatId, seed.agent.uuid, { [CONTEXT_DECISION_METADATA_KEY]: receipt() });
    // Never storable: the schema rejects it, so it cannot reach the ranking.
    await sendMessage(seed.chatId, seed.agent.uuid, {
      [CONTEXT_DECISION_METADATA_KEY]: receipt({
        evidence: [{ repoUrl: REPO, commit: COMMIT, nodePath: `/${TENANCY}` }],
      }),
    });

    const summary = await summarize(seed.organizationId);
    expect(summary.decisionCount).toBe(2);
    expect(summary.nodes).toEqual([{ nodePath: TENANCY, decisionCount: 2 }]);
  });

  it("drops the whole ranking when the snapshot declares no known nodes", async () => {
    const seed = await seedChat();
    await sendMessage(seed.chatId, seed.agent.uuid, { [CONTEXT_DECISION_METADATA_KEY]: receipt() });

    const summary = await summarize(seed.organizationId, { knownNodePaths: new Set<string>() });
    // Silence is the safe failure — never "publish whatever the note claimed".
    expect(summary.decisionCount).toBe(1);
    expect(summary.nodes).toEqual([]);
  });

  it("excludes receipts older than the window", async () => {
    const seed = await seedChat();
    const stale = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await sendMessage(seed.chatId, seed.agent.uuid, { [CONTEXT_DECISION_METADATA_KEY]: receipt() }, stale);

    const summary = await summarize(seed.organizationId);
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

    expect((await summarize(seed.organizationId)).decisionCount).toBe(0);
    expect((await summarize(otherOrgId)).decisionCount).toBe(1);
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

    const summary = await summarize(seed.organizationId);
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

    const summary = await summarize(seed.organizationId);
    // Fail closed: with no viewer nobody has proven chat access, so no
    // body-derived prose leaves the Server even though the decision is counted.
    expect(summary.decisionCount).toBe(1);
    expect(summary.recentEvents).toEqual([]);

    await getApp()
      .db.insert(chatMembership)
      .values({ chatId: seed.chatId, agentId: seed.humanAgentUuid, accessMode: "speaker" });
    const withAccess = await summarize(seed.organizationId, {
      viewer: { humanAgentId: seed.humanAgentUuid, memberId: seed.memberId },
    });
    expect(withAccess.recentEvents[0]).toMatchObject({
      id: messageId,
      agentId: seed.agent.uuid,
      chatId: seed.chatId,
      chatTitle: "Release cut",
      effect: "conflicted",
      summary: "Two release rules cannot both hold.",
    });
    expect(withAccess.recentEvents[0]?.evidence[0]?.nodePath).toBe(TENANCY);
  });

  // `summary` and `evidence` come straight out of a private message body, so an
  // inaccessible event is omitted rather than shown with the link disabled.
  it("omits decisions from chats the viewer cannot open", async () => {
    const app = getApp();
    const seed = await seedChat();
    await sendMessage(seed.chatId, seed.agent.uuid, { [CONTEXT_DECISION_METADATA_KEY]: receipt() });

    const outsider = await summarize(seed.organizationId, {
      viewer: { humanAgentId: `human-${crypto.randomUUID()}`, memberId: `member-${crypto.randomUUID()}` },
    });
    // The aggregate stays org-wide; the body-derived prose does not leak.
    expect(outsider.decisionCount).toBe(1);
    expect(outsider.recentEvents).toEqual([]);

    await app.db
      .insert(chatMembership)
      .values({ chatId: seed.chatId, agentId: seed.humanAgentUuid, accessMode: "speaker" });
    const member = await summarize(seed.organizationId, {
      viewer: { humanAgentId: seed.humanAgentUuid, memberId: seed.memberId },
    });
    expect(member.recentEvents).toHaveLength(1);
    expect(member.recentEvents[0]?.summary).toContain("organization-isolation");
  });
  // A citation pointing elsewhere belongs to a different tree, or to a binding
  // that has since moved. Counting it here would attribute another repo's node
  // to this Team, and grouping by path alone would merge the two.
  it("ignores citations that do not point at the bound repository", async () => {
    const seed = await seedChat();
    await sendMessage(seed.chatId, seed.agent.uuid, {
      [CONTEXT_DECISION_METADATA_KEY]: receipt({
        evidence: [{ repoUrl: "https://github.com/acme/some-other-tree", commit: COMMIT, nodePath: TENANCY }],
      }),
    });
    await sendMessage(seed.chatId, seed.agent.uuid, { [CONTEXT_DECISION_METADATA_KEY]: receipt() });

    const summary = await summarize(seed.organizationId);
    expect(summary.decisionCount).toBe(1);
    expect(summary.nodes).toEqual([{ nodePath: TENANCY, decisionCount: 1 }]);
  });

  it("matches the bound repository across equivalent spellings", async () => {
    const seed = await seedChat();
    await sendMessage(seed.chatId, seed.agent.uuid, { [CONTEXT_DECISION_METADATA_KEY]: receipt() });

    for (const bound of [`${REPO}.git`, "git@github.com:acme/first-tree-context.git"]) {
      expect((await summarize(seed.organizationId, { boundRepoUrl: bound })).decisionCount).toBe(1);
    }
  });

  // `canonicalGitRepoUrl` drops the HTTPS port by design, so a port-blind
  // comparison would treat two different self-managed GitLab instances as one.
  it("does not match a self-managed GitLab citation across a different port", async () => {
    const seed = await seedChat();
    const cited = "https://gitlab.example.com:8443/group/tree";
    await sendMessage(seed.chatId, seed.agent.uuid, {
      [CONTEXT_DECISION_METADATA_KEY]: receipt({
        evidence: [{ repoUrl: cited, commit: COMMIT, nodePath: TENANCY }],
      }),
    });

    const wrongPort = await summarize(seed.organizationId, {
      boundRepoUrl: "https://gitlab.example.com/group/tree",
      boundProvider: "gitlab",
      gitlabInstanceOrigin: "https://gitlab.example.com",
    });
    expect(wrongPort.decisionCount).toBe(0);

    const samePort = await summarize(seed.organizationId, {
      boundRepoUrl: cited,
      boundProvider: "gitlab",
      gitlabInstanceOrigin: "https://gitlab.example.com:8443",
    });
    expect(samePort.decisionCount).toBe(1);
  });

  it("reports nothing when the organization has no Context Tree binding", async () => {
    const seed = await seedChat();
    await sendMessage(seed.chatId, seed.agent.uuid, { [CONTEXT_DECISION_METADATA_KEY]: receipt() });

    expect((await summarize(seed.organizationId, { boundRepoUrl: null })).decisionCount).toBe(0);
  });
});
