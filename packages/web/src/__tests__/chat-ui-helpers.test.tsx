import type { AgentChatStatus, GithubEventCard } from "@first-tree/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { canPauseStatus } from "../components/chat/agent-status-panel.js";
import { pickLead, selectAttention } from "../components/chat/compose-status-bar.js";
import {
  GithubEventCardMessage,
  GithubSystemAvatar,
  isGithubEventCardContent,
  isGithubSystemSenderMetadata,
  isTrustedGithubDispatcherMessage,
} from "../components/chat/github-event-card.js";
import { rehypeMentions } from "../components/rehype-mentions.js";
import {
  docSnapshotQueryKey,
  documentSnapshotMapFromMetadata,
  failedDocMentionsFromMetadata,
} from "../pages/workspace/center/chat-view.js";
import { pickDefault } from "../pages/workspace/conversations/new-chat-draft.js";

const iso = "2026-05-28T00:00:00.000Z";

function card(overrides: Partial<GithubEventCard> = {}): GithubEventCard {
  return {
    type: "github_event",
    reason: "mentioned",
    event: "issues",
    action: "opened",
    kind: "opened",
    repository: "agent-team-foundation/first-tree",
    sender: "octocat",
    title: "Tighten tests",
    body: "Please check this @ada before release.",
    url: "https://github.com/agent-team-foundation/first-tree/issues/1",
    entity: {
      type: "issue",
      key: "agent-team-foundation/first-tree#1",
      url: "https://github.com/agent-team-foundation/first-tree/issues/1",
    },
    mentionedUser: "ada",
    ...overrides,
  };
}

function status(agentId: string, main: AgentChatStatus["main"], startedAt = iso): AgentChatStatus {
  return {
    agentId,
    reachable: true,
    errored: main === "failed",
    needsYou: main === "needs_you",
    working: main === "working",
    engagement: main === "working" ? "active" : "none",
    main,
    activity: main === "working" ? { agentId, kind: "tool_call", label: "Bash", startedAt } : null,
  };
}

describe("GitHub event card helpers", () => {
  it("validates trusted dispatcher messages with the full conjunctive gate", () => {
    const content = card();
    expect(isGithubEventCardContent(content)).toBe(true);
    expect(isGithubSystemSenderMetadata({ systemSender: "github" })).toBe(true);
    expect(
      isTrustedGithubDispatcherMessage({
        source: "github",
        format: "card",
        content,
        metadata: { systemSender: "github" },
      }),
    ).toBe(true);
    expect(
      isTrustedGithubDispatcherMessage({
        source: "web",
        format: "card",
        content,
        metadata: { systemSender: "github" },
      }),
    ).toBe(false);
    expect(isGithubEventCardContent({ kind: "opened" })).toBe(false);
    expect(isGithubSystemSenderMetadata(null)).toBe(false);
  });

  it("renders card variants across reasons, entity types, links, and mention highlighting", () => {
    const kinds: GithubEventCard["kind"][] = [
      "opened",
      "closed",
      "merged",
      "reopened",
      "commented",
      "reviewed",
      "review_comment",
      "review_requested",
      "synchronized",
      "commit_commented",
      "assigned",
      "edited",
      "other",
    ];
    const reasons: GithubEventCard["reason"][] = ["mentioned", "review_requested", "assigned", "subscribed"];
    const entityTypes: GithubEventCard["entity"]["type"][] = ["issue", "pull_request", "discussion", "commit"];

    for (const [index, kind] of kinds.entries()) {
      const entityType = entityTypes[index % entityTypes.length] ?? "issue";
      const html = renderToStaticMarkup(
        <GithubEventCardMessage
          content={card({
            reason: reasons[index % reasons.length],
            kind,
            entity: {
              type: entityType,
              key: index % 2 === 0 ? `agent-team-foundation/first-tree#${index + 1}` : `other/repo@abc${index}`,
              url: index % 3 === 0 ? null : `https://github.com/example/${index}`,
            },
            body: index % 2 === 0 ? "ping @ada now" : "ada should see this",
            mentionedUser: "ada",
            title: index % 4 === 0 ? "" : `Title ${index}`,
            url: index % 5 === 0 ? "" : `https://github.com/fallback/${index}`,
          })}
        />,
      );
      expect(html).toContain("first-tree");
    }

    expect(renderToStaticMarkup(<GithubSystemAvatar size={24} />)).toContain("GitHub");
  });
});

describe("chat status helpers", () => {
  it("sorts active attention and keeps a working lead stable until the hold expires", () => {
    const workingOld = status("agent-old", "working", "2026-05-28T00:00:01.000Z");
    const workingNew = status("agent-new", "working", "2026-05-28T00:00:05.000Z");
    const failed = status("agent-failed", "failed");

    expect(
      selectAttention([status("agent-ready", "ready"), workingOld, failed, workingNew]).map((s) => s.agentId),
    ).toEqual(["agent-failed", "agent-old", "agent-new"]);
    expect(pickLead({ agentId: "agent-old", since: 1_000 }, 2_000, [], [workingOld, workingNew], 4_000)).toEqual({
      agentId: "agent-old",
      since: 1_000,
    });
    expect(pickLead({ agentId: "agent-old", since: 1_000 }, 6_000, [], [workingOld, workingNew], 4_000)).toEqual({
      agentId: "agent-new",
      since: 6_000,
    });
    expect(pickLead(null, 7_000, [status("agent-needs", "needs_you")], [workingNew], 4_000)).toEqual({
      agentId: "agent-needs",
      since: 7_000,
    });
    expect(pickLead(null, 7_000, [], [], 4_000)).toBeNull();
    expect(canPauseStatus(workingNew)).toBe(true);
    expect(canPauseStatus(status("agent-paused", "paused"))).toBe(false);
    expect(canPauseStatus(null)).toBe(false);
  });
});

describe("document and mention helpers", () => {
  it("extracts snapshot metadata and failed document mentions", () => {
    const sha = "a".repeat(64);
    const metadata = {
      documentContext: {
        kind: "snapshot",
        docs: [{ path: "docs/intro.md", content: "# Intro", sha256: sha, size: 7 }],
        failedMentions: [
          { raw: "docs/missing.md", reason: "missing" },
          { raw: "docs/secret.md", reason: "out-of-fence" },
        ],
      },
    };

    expect(documentSnapshotMapFromMetadata(metadata)?.get("docs/intro.md")).toEqual({
      path: "docs/intro.md",
      content: "# Intro",
      sha256: sha,
      size: 7,
    });
    expect(failedDocMentionsFromMetadata(metadata)?.get("docs/missing.md")).toBe("missing");
    expect(
      documentSnapshotMapFromMetadata({ documentContext: { kind: "path", basePath: "/tmp/work" } }),
    ).toBeUndefined();
    expect(
      failedDocMentionsFromMetadata({
        documentContext: { kind: "snapshot", docs: [{ path: "docs/a.md", content: "", sha256: sha, size: 0 }] },
      }),
    ).toBeUndefined();
    expect(docSnapshotQueryKey("chat-1", "msg-1", "docs/intro.md")).toEqual([
      "chat-doc-snapshot",
      "chat-1",
      "msg-1",
      "docs/intro.md",
    ]);
  });

  it("rewrites known mentions while skipping links and code nodes", () => {
    const plugin = rehypeMentions([{ agentId: "agent-ada", name: "ada" }]);
    type MentionTree = Parameters<ReturnType<ReturnType<typeof rehypeMentions>>>[0];
    const tree: MentionTree = {
      type: "root",
      children: [
        { type: "text", value: "hello @ada and @unknown" },
        { type: "element", tagName: "code", children: [{ type: "text", value: "@ada" }] },
        { type: "element", tagName: "a", children: [{ type: "text", value: "@ada" }] },
      ],
    };

    plugin()(tree);

    expect(tree.children[1]).toMatchObject({
      type: "element",
      tagName: "span",
      properties: { "data-mention-agent-id": "agent-ada", "data-mention-name": "ada" },
    });
    expect(tree.children[2]).toMatchObject({ type: "text", value: " and @unknown" });

    const emptyTree: MentionTree = { type: "root", children: [{ type: "text", value: "@ada" }] };
    rehypeMentions([])()(emptyTree);
    expect(emptyTree.children).toEqual([{ type: "text", value: "@ada" }]);
  });
});

describe("new chat default picker", () => {
  it("seeds only a valid non-suspended delegate for the current human agent", () => {
    const orgAgents = [
      { uuid: "human-1", type: "human", managerId: "member-1", status: "active", delegateMention: "agent-1" },
      { uuid: "agent-1", type: "agent", managerId: "member-1", status: "active", delegateMention: null },
      { uuid: "agent-2", type: "agent", managerId: "member-1", status: "suspended", delegateMention: null },
    ] satisfies Parameters<typeof pickDefault>[0];
    const suspendedDelegateAgents = [
      { uuid: "human-1", type: "human", managerId: "member-1", status: "active", delegateMention: "agent-2" },
      ...orgAgents.slice(1),
    ] satisfies Parameters<typeof pickDefault>[0];

    expect(pickDefault(orgAgents, "human-1")).toBe("agent-1");
    expect(pickDefault(suspendedDelegateAgents, "human-1")).toBeNull();
    expect(pickDefault(orgAgents, null)).toBeNull();
    expect(pickDefault(orgAgents, "missing-human")).toBeNull();
  });
});
