import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { ChatParticipantDetail } from "@first-tree/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAgentEnv,
  createParticipantCache,
  formatInboundContent,
  resolveSenderLabel,
} from "../runtime/agent-io.js";
import { writeAttachmentFile } from "../runtime/attachment-store.js";
import { setCliBinding } from "../runtime/cli-binding.js";
import type { SessionMessage } from "../runtime/handler.js";
import type { FirstTreeHubSDK } from "../sdk.js";

function mkParticipant(agentId: string, name: string | null, displayName?: string): ChatParticipantDetail {
  return {
    agentId,
    role: "member",
    mode: "full",
    joinedAt: new Date().toISOString(),
    name,
    // Post-Phase 2 the wire shape requires a non-null display name; fall
    // back to a synthetic label when the caller doesn't provide one.
    displayName: displayName ?? `agent-${agentId}`,
    type: "agent",
    avatarColorToken: null,
    avatarImageUrl: null,
  };
}

function mkSdk(listImpl?: () => Promise<ChatParticipantDetail[]>): FirstTreeHubSDK {
  const sdk = {
    serverUrl: "http://test",
    listChatParticipants: listImpl ? vi.fn(listImpl) : vi.fn().mockResolvedValue([]),
  } as unknown as FirstTreeHubSDK;
  return sdk;
}

const githubCard = {
  type: "github_event",
  reason: "subscribed",
  event: "issues",
  action: "opened",
  kind: "opened",
  repository: "acme/widgets",
  sender: "octocat",
  title: "Issue #42: Broken widget",
  body: "Please investigate",
  url: "https://github.com/acme/widgets/issues/42",
  entity: {
    type: "issue",
    key: "acme/widgets#42",
    url: "https://github.com/acme/widgets/issues/42",
  },
};

const gitlabCard = {
  type: "gitlab_event",
  event: "issue",
  action: "open",
  kind: "opened",
  project: "acme/widgets",
  sender: "alice",
  title: "Broken widget",
  body: "Please investigate",
  url: "https://gitlab.example/acme/widgets/-/issues/42",
  entity: {
    type: "issue",
    key: "501:issue:42",
    url: "https://gitlab.example/acme/widgets/-/issues/42",
  },
};

afterEach(() => {
  setCliBinding({ binName: "first-tree", packageName: "first-tree" });
});

describe("resolveSenderLabel", () => {
  const ps = [
    mkParticipant("agent-a", "alice", "Alice Smith"),
    mkParticipant("agent-b", null, "Bob Only"),
    // Pre-Phase-2 nullable displayName is gone, but `""` is still a
    // reachable DB state (the temporary DEFAULT '' added by migration
    // 0024 catches old INSERTs during a rolling deploy). Keep the
    // "both falsy" coverage by pinning the empty-string branch.
    mkParticipant("agent-c", null, ""),
  ];

  it("returns the participant name when available", () => {
    expect(resolveSenderLabel("agent-a", ps)).toBe("alice");
  });

  it("falls back to displayName when name is null", () => {
    expect(resolveSenderLabel("agent-b", ps)).toBe("Bob Only");
  });

  it("falls back to the raw senderId when name is null and displayName is empty", () => {
    // Covers the `return senderId` branch inside the participant-match
    // loop (runtime/agent-io.ts) — still reachable for rows that came
    // in under the migration 0024 rollout default.
    expect(resolveSenderLabel("agent-c", ps)).toBe("agent-c");
  });

  it("returns the raw senderId when not present among participants (stale cache / ex-member)", () => {
    expect(resolveSenderLabel("agent-unknown", ps)).toBe("agent-unknown");
  });
});

describe("formatInboundContent", () => {
  const participants = [mkParticipant("agent-a", "alice")];

  it("prefixes [From: <name>] when the sender is a known participant", async () => {
    const sdk = mkSdk(async () => participants);
    const cache = createParticipantCache(sdk, "chat-1", () => {});
    const msg: SessionMessage = {
      id: "m1",
      chatId: "chat-1",
      senderId: "agent-a",
      format: "text",
      content: "hello",
      metadata: null,
    };
    expect(await formatInboundContent(msg, cache)).toBe("[From: alice · type=agent]\n\nhello");
  });

  it("resolves the participant SDK lazily so rebound sessions use the current transport", async () => {
    const firstSdk = mkSdk(async () => []);
    const secondSdk = mkSdk(async () => participants);
    let currentSdk = firstSdk;
    const cache = createParticipantCache(
      () => currentSdk,
      "chat-1",
      () => {},
    );
    currentSdk = secondSdk;

    expect(await cache.get()).toEqual(participants);
    expect(firstSdk.listChatParticipants).not.toHaveBeenCalled();
    expect(secondSdk.listChatParticipants).toHaveBeenCalledWith("chat-1");
  });

  it("does not append an agent-only directive for legacy First Tree onboarding metadata", async () => {
    const sdk = mkSdk(async () => participants);
    const cache = createParticipantCache(sdk, "chat-1", () => {});
    const msg: SessionMessage = {
      id: "m1",
      chatId: "chat-1",
      senderId: "agent-a",
      format: "markdown",
      content: "Welcome to First Tree.",
      metadata: { systemSender: "first_tree_onboarding" },
    };
    const out = await formatInboundContent(msg, cache);
    expect(out).toBe("[From: alice · type=agent]\n\nWelcome to First Tree.");
  });

  it("does not append a campaign directive for legacy campaign metadata", async () => {
    const sdk = mkSdk(async () => participants);
    const cache = createParticipantCache(sdk, "chat-1", () => {});
    const msg: SessionMessage = {
      id: "m1",
      chatId: "chat-1",
      senderId: "agent-a",
      format: "markdown",
      content: "Welcome to First Tree.",
      metadata: { systemSender: "first_tree_onboarding", campaign: "production-scan" },
    };
    const out = await formatInboundContent(msg, cache);
    expect(out).toBe("[From: alice · type=agent]\n\nWelcome to First Tree.");
  });

  it("ignores a malformed legacy campaign slug without adding fallback instructions", async () => {
    const sdk = mkSdk(async () => participants);
    const cache = createParticipantCache(sdk, "chat-1", () => {});
    const msg: SessionMessage = {
      id: "m1",
      chatId: "chat-1",
      senderId: "agent-a",
      format: "markdown",
      content: "Welcome to First Tree.",
      metadata: { systemSender: "first_tree_onboarding", campaign: "../etc/passwd" },
    };
    const out = await formatInboundContent(msg, cache);
    expect(out).toBe("[From: alice · type=agent]\n\nWelcome to First Tree.");
  });

  it("does not append hidden directives for other system senders", async () => {
    const sdk = mkSdk(async () => participants);
    const cache = createParticipantCache(sdk, "chat-1", () => {});
    const msg: SessionMessage = {
      id: "m1",
      chatId: "chat-1",
      senderId: "agent-a",
      format: "markdown",
      content: "PR opened",
      metadata: { systemSender: "github" },
    };
    expect(await formatInboundContent(msg, cache)).toBe("[From: alice · type=agent]\n\nPR opened");
  });

  it.each([
    ["GitHub", "github", githubCard],
    ["GitLab", "gitlab", gitlabCard],
  ])("attributes a trusted %s dispatcher card as system", async (name, source, content) => {
    const cache = createParticipantCache(
      mkSdk(async () => participants),
      "chat-1",
      () => {},
    );
    const msg: SessionMessage = {
      id: "m1",
      chatId: "chat-1",
      senderId: "agent-a",
      source,
      format: "card",
      content,
      metadata: { systemSender: source },
    };

    expect(await formatInboundContent(msg, cache)).toBe(`[From: ${name} · type=system]\n\n${JSON.stringify(content)}`);
  });

  it.each([
    { state: "pending" },
    {
      state: "submitting",
      payloadHash: "hash",
      attemptId: "attempt-1",
      reviewedHead: "a".repeat(40),
      event: "APPROVE",
      claimedAt: "2026-07-21T00:00:00.000Z",
      reviewerClientId: "client-1",
    },
    {
      state: "unknown",
      payloadHash: "hash",
      attemptId: "attempt-1",
      reviewedHead: "a".repeat(40),
      event: "COMMENT",
      failedAt: "2026-07-21T00:00:00.000Z",
      reviewerClientId: "client-1",
    },
    {
      state: "failed",
      payloadHash: "hash",
      code: "CONTEXT_REVIEW_GITHUB_REJECTED",
      failedAt: "2026-07-21T00:00:00.000Z",
    },
    {
      state: "submitted",
      payloadHash: "hash",
      reviewedHead: "a".repeat(40),
      event: "APPROVE",
      reviewId: 42,
      reviewUrl: "https://github.com/acme/context-tree/pull/42#pullrequestreview-42",
      appActor: "first-tree[bot]",
      submittedAt: "2026-07-21T00:00:00.000Z",
      reviewerAgentUuid: "reviewer-1",
      reviewerManagerHumanAgentId: "human-1",
      reviewerClientId: "client-1",
      reviewerManagerGithubLogin: null,
    },
  ])("keeps a trusted Context Reviewer run attributed to GitHub in $state", async (contextReviewSubmission) => {
    const cache = createParticipantCache(
      mkSdk(async () => participants),
      "chat-1",
      () => {},
    );
    const msg: SessionMessage = {
      id: "m1",
      chatId: "chat-1",
      senderId: "agent-a",
      source: "github",
      format: "markdown",
      content: "Review this exact Context Tree head.",
      metadata: {
        source: "github",
        contextTreeReviewer: true,
        contextReviewRunId: "run-1",
        contextReviewRepository: "acme/context-tree",
        contextReviewPrNumber: 42,
        contextReviewHeadSha: "a".repeat(40),
        contextReviewOrganizationId: "org-1",
        contextReviewReviewerAgentUuid: "reviewer-1",
        contextReviewReviewerManagerHumanAgentId: "human-1",
        contextReviewSubmission,
      },
    };

    expect(await formatInboundContent(msg, cache)).toBe(
      "[From: GitHub · type=system]\n\nReview this exact Context Tree head.",
    );
  });

  it("preserves GitHub attribution for retired managed-review history", async () => {
    const cache = createParticipantCache(
      mkSdk(async () => participants),
      "chat-1",
      () => {},
    );
    const msg: SessionMessage = {
      id: "m1",
      chatId: "chat-1",
      senderId: "agent-a",
      source: "github",
      format: "markdown",
      content: "Historical managed review task.",
      metadata: {
        source: "github",
        systemSender: "github",
        contextReviewManagedEventV1: {
          schemaVersion: 1,
          eventType: "pull_request",
          action: "opened",
          triggerEvent: "pull_request.opened",
          repository: "acme/context-tree",
          pullRequest: 42,
          senderLogin: "writer",
        },
      },
    };

    expect(await formatInboundContent(msg, cache)).toBe(
      "[From: GitHub · type=system]\n\nHistorical managed review task.",
    );
  });

  it("does not trust a caller-provided systemSender marker", async () => {
    const cache = createParticipantCache(
      mkSdk(async () => participants),
      "chat-1",
      () => {},
    );
    const msg: SessionMessage = {
      id: "m1",
      chatId: "chat-1",
      senderId: "agent-a",
      source: "api",
      format: "card",
      content: githubCard,
      metadata: { systemSender: "github" },
    };

    expect(await formatInboundContent(msg, cache)).toBe(`[From: alice · type=agent]\n\n${JSON.stringify(githubCard)}`);
  });

  it("annotates the header with the sender type and send time when both are known", async () => {
    const sdk = mkSdk(async () => participants);
    const cache = createParticipantCache(sdk, "chat-1", () => {});
    const msg: SessionMessage = {
      id: "m1",
      chatId: "chat-1",
      senderId: "agent-a",
      format: "text",
      content: "hello",
      metadata: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    expect(await formatInboundContent(msg, cache)).toBe(
      "[From: alice · type=agent · sent=2026-01-01T00:00:00.000Z]\n\nhello",
    );
  });

  it("falls back to senderId in the prefix when the sender is not a participant", async () => {
    const sdk = mkSdk(async () => participants);
    const cache = createParticipantCache(sdk, "chat-1", () => {});
    const msg: SessionMessage = {
      id: "m1",
      chatId: "chat-1",
      senderId: "agent-ghost",
      format: "text",
      content: "hi",
      metadata: null,
    };
    expect(await formatInboundContent(msg, cache)).toBe("[From: agent-ghost]\n\nhi");
  });

  it("serialises non-string content to JSON under the same attribution", async () => {
    const sdk = mkSdk(async () => participants);
    const cache = createParticipantCache(sdk, "chat-1", () => {});
    const msg: SessionMessage = {
      id: "m1",
      chatId: "chat-1",
      senderId: "agent-a",
      format: "card",
      content: { title: "hi" },
      metadata: null,
    };
    expect(await formatInboundContent(msg, cache)).toBe(
      `[From: alice · type=agent]\n\n${JSON.stringify({ title: "hi" })}`,
    );
  });

  it("omits the attribution prefix when senderId is empty", async () => {
    const sdk = mkSdk(async () => participants);
    const cache = createParticipantCache(sdk, "chat-1", () => {});
    const msg: SessionMessage = {
      id: "m1",
      chatId: "chat-1",
      senderId: "",
      format: "text",
      content: "anon",
      metadata: null,
    };
    expect(await formatInboundContent(msg, cache)).toBe("anon");
  });

  it("renders a batched image message (caption + N refs) instead of a JSON dump", async () => {
    const sdk = mkSdk(async () => participants);
    const cache = createParticipantCache(sdk, "chat-1", () => {});
    const msg: SessionMessage = {
      id: "m1",
      chatId: "chat-1",
      senderId: "agent-a",
      format: "file",
      content: {
        caption: "look at these",
        attachments: [
          { imageId: "9c2ce4e7-3f0d-4f53-9c0c-1c93e7d51a92", mimeType: "image/png", filename: "a.png" },
          { imageId: "11111111-1111-4111-8111-111111111111", mimeType: "image/png", filename: "b.png" },
        ],
      },
      metadata: null,
    };
    const out = await formatInboundContent(msg, cache);
    // Bytes never landed on this client (no `writeImage` ran in the test
    // harness) so each attachment surfaces the not-available placeholder.
    // The point: caption + per-image lines, not a `{"caption":"…"}` blob.
    expect(out).toContain("[From: alice · type=agent]");
    expect(out).toContain("look at these");
    expect(out).toContain("2 images were shared");
    expect(out).toContain("a.png");
    expect(out).toContain("b.png");
    expect(out).not.toContain('{"caption"');
  });

  it("renders a single image ref (pre-batch shape) as filename + placeholder", async () => {
    const sdk = mkSdk(async () => participants);
    const cache = createParticipantCache(sdk, "chat-1", () => {});
    const msg: SessionMessage = {
      id: "m1",
      chatId: "chat-1",
      senderId: "agent-a",
      format: "file",
      content: {
        imageId: "9c2ce4e7-3f0d-4f53-9c0c-1c93e7d51a92",
        mimeType: "image/png",
        filename: "legacy.png",
      },
      metadata: null,
    };
    const out = await formatInboundContent(msg, cache);
    expect(out).toContain("[From: alice · type=agent]");
    expect(out).toContain("legacy.png");
    expect(out).not.toContain('{"imageId"');
  });

  it("appends document attachment paths to inbound text for the agent", async () => {
    const home = join(tmpdir(), `ft-agent-io-attachments-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    vi.stubEnv("FIRST_TREE_HOME", home);
    try {
      const attachmentPath = await writeAttachmentFile({
        chatId: "chat-1",
        attachmentId: "11111111-1111-4111-8111-111111111111",
        filename: "evidence.pdf",
        base64: Buffer.from("pdf bytes").toString("base64"),
      });
      const sdk = mkSdk(async () => participants);
      const cache = createParticipantCache(sdk, "chat-1", () => {});
      const msg: SessionMessage = {
        id: "m1",
        chatId: "chat-1",
        senderId: "agent-a",
        format: "text",
        content: "Please inspect this file.",
        metadata: {
          attachments: [
            {
              attachmentId: "11111111-1111-4111-8111-111111111111",
              kind: "file",
              mimeType: "application/pdf",
              filename: "evidence.pdf",
              size: 9,
            },
          ],
        },
      };

      const out = await formatInboundContent(msg, cache);

      expect(out).toContain("Please inspect this file.");
      expect(out).toContain("A file was shared in this chat");
      expect(out).toContain("Filename: evidence.pdf");
      expect(out).toContain(`Path: ${attachmentPath}`);
      expect(out).not.toContain("not available");
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("renders an unavailable note when a document attachment was not written locally", async () => {
    const sdk = mkSdk(async () => participants);
    const cache = createParticipantCache(sdk, "chat-1", () => {});
    const msg: SessionMessage = {
      id: "m1",
      chatId: "chat-1",
      senderId: "agent-a",
      format: "text",
      content: "Please inspect this file.",
      metadata: {
        attachments: [
          {
            attachmentId: "22222222-2222-4222-8222-222222222222",
            kind: "document",
            mimeType: "text/csv",
            filename: "missing.csv",
            size: 12,
          },
        ],
      },
    };

    const out = await formatInboundContent(msg, cache);

    expect(out).toContain("Please inspect this file.");
    expect(out).toContain('File "missing.csv" not available on this device');
    expect(out).not.toContain("Path:");
  });

  it("ignores malformed attachment metadata when rendering inbound text", async () => {
    const sdk = mkSdk(async () => participants);
    const cache = createParticipantCache(sdk, "chat-1", () => {});
    const msg: SessionMessage = {
      id: "m1",
      chatId: "chat-1",
      senderId: "agent-a",
      format: "text",
      content: "Plain message.",
      metadata: { attachments: "not-an-array" },
    };

    const out = await formatInboundContent(msg, cache);

    expect(out).toBe("[From: alice · type=agent]\n\nPlain message.");
    expect(out).not.toContain("file was shared");
  });

  it("does not render image metadata attachments as document files", async () => {
    const sdk = mkSdk(async () => participants);
    const cache = createParticipantCache(sdk, "chat-1", () => {});
    const msg: SessionMessage = {
      id: "m1",
      chatId: "chat-1",
      senderId: "agent-a",
      format: "text",
      content: "Image metadata only.",
      metadata: {
        attachments: [
          {
            attachmentId: "33333333-3333-4333-8333-333333333333",
            kind: "image",
            mimeType: "image/png",
            filename: "chart.png",
            size: 1024,
          },
        ],
      },
    };

    const out = await formatInboundContent(msg, cache);

    expect(out).toBe("[From: alice · type=agent]\n\nImage metadata only.");
    expect(out).not.toContain("chart.png");
    expect(out).not.toContain("file was shared");
  });

  it("only calls listChatParticipants once across many messages (cache hit)", async () => {
    const listFn = vi.fn().mockResolvedValue(participants);
    const sdk = { serverUrl: "http://test", listChatParticipants: listFn } as unknown as FirstTreeHubSDK;
    const cache = createParticipantCache(sdk, "chat-1", () => {});
    const msg: SessionMessage = {
      id: "m1",
      chatId: "chat-1",
      senderId: "agent-a",
      format: "text",
      content: "x",
      metadata: null,
    };
    await formatInboundContent(msg, cache);
    await formatInboundContent(msg, cache);
    await formatInboundContent(msg, cache);
    expect(listFn).toHaveBeenCalledTimes(1);
  });

  it("shares an inflight participant fetch across concurrent callers", async () => {
    let resolveRows: (rows: ChatParticipantDetail[]) => void = () => {};
    const listFn = vi.fn(
      () =>
        new Promise<ChatParticipantDetail[]>((resolve) => {
          resolveRows = resolve;
        }),
    );
    const sdk = { serverUrl: "http://test", listChatParticipants: listFn } as unknown as FirstTreeHubSDK;
    const cache = createParticipantCache(sdk, "chat-1", () => {});

    const first = cache.get();
    const second = cache.get();
    resolveRows(participants);

    await expect(Promise.all([first, second])).resolves.toEqual([participants, participants]);
    expect(listFn).toHaveBeenCalledTimes(1);
  });

  it("returns [] from the cache on fetch failure and logs (graceful degrade)", async () => {
    const logs: string[] = [];
    const sdk = mkSdk(() => Promise.reject(new Error("server down")));
    const cache = createParticipantCache(sdk, "chat-1", (m) => logs.push(m));
    const msg: SessionMessage = {
      id: "m1",
      chatId: "chat-1",
      senderId: "agent-a",
      format: "text",
      content: "hi",
      metadata: null,
    };
    // Without participants we can't resolve "agent-a" → "alice"; fall back to id.
    expect(await formatInboundContent(msg, cache)).toBe("[From: agent-a]\n\nhi");
    expect(logs.some((l) => l.includes("listChatParticipants failed"))).toBe(true);
  });

  it("logs non-Error participant fetch failures", async () => {
    const logs: string[] = [];
    const sdk = mkSdk(() => Promise.reject("server string failure"));
    const cache = createParticipantCache(sdk, "chat-1", (m) => logs.push(m));

    expect(await cache.get()).toEqual([]);
    expect(logs).toContain("listChatParticipants failed: server string failure");
  });

  it("resets inflight after a successful direct cache fetch", async () => {
    const listFn = vi.fn().mockResolvedValue(participants);
    const cache = createParticipantCache(mkSdk(listFn), "chat-1", () => {});

    await expect(cache.get()).resolves.toEqual(participants);
    await expect(cache.get()).resolves.toEqual(participants);
    expect(listFn).toHaveBeenCalledTimes(1);
  });

  it("renders precedingMessages as an [Earlier in chat] block before the trigger", async () => {
    const ps = [mkParticipant("agent-a", "alice"), mkParticipant("agent-b", "bob"), mkParticipant("agent-c", "carol")];
    const sdk = mkSdk(async () => ps);
    const cache = createParticipantCache(sdk, "chat-1", () => {});
    const msg: SessionMessage = {
      id: "m3",
      chatId: "chat-1",
      senderId: "agent-c",
      format: "text",
      content: "@me what do you think?",
      metadata: null,
      precedingMessages: [
        {
          id: "m1",
          senderId: "agent-a",
          format: "text",
          content: "anyone seen the report?",
          metadata: {},
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "m2",
          senderId: "agent-b",
          format: "text",
          content: "yeah, working on it",
          metadata: {},
          createdAt: "2026-01-01T00:00:01.000Z",
        },
      ],
    };
    const out = await formatInboundContent(msg, cache);
    expect(out).toContain("[Earlier in chat — context you missed]");
    expect(out).toContain("[From: alice · type=agent · sent=2026-01-01T00:00:00.000Z] anyone seen the report?");
    expect(out).toContain("[From: bob · type=agent · sent=2026-01-01T00:00:01.000Z] yeah, working on it");
    expect(out).toContain("[Now — message that woke you]");
    expect(out).toContain("[From: carol · type=agent]\n\n@me what do you think?");
    // Ordering: earlier block must precede the trigger.
    expect(out.indexOf("[Earlier in chat")).toBeLessThan(out.indexOf("[Now — message"));
    expect(out.indexOf("[Now — message")).toBeLessThan(out.indexOf("[From: carol · type=agent]"));
  });

  it("serializes structured preceding message content", async () => {
    const ps = [mkParticipant("agent-a", "alice"), mkParticipant("agent-b", "bob")];
    const sdk = mkSdk(async () => ps);
    const cache = createParticipantCache(sdk, "chat-1", () => {});
    const msg: SessionMessage = {
      id: "m2",
      chatId: "chat-1",
      senderId: "agent-b",
      format: "text",
      content: "latest",
      metadata: null,
      precedingMessages: [
        {
          id: "m1",
          senderId: "agent-a",
          format: "card",
          content: { title: "earlier" },
          metadata: {},
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };

    const out = await formatInboundContent(msg, cache);

    expect(out).toContain(
      `[From: alice · type=agent · sent=2026-01-01T00:00:00.000Z] ${JSON.stringify({ title: "earlier" })}`,
    );
  });

  it("preserves trusted SCM system attribution in preceding silent context", async () => {
    const ps = [mkParticipant("agent-a", "alice"), mkParticipant("agent-b", "bob")];
    const cache = createParticipantCache(
      mkSdk(async () => ps),
      "chat-1",
      () => {},
    );
    const msg: SessionMessage = {
      id: "m3",
      chatId: "chat-1",
      senderId: "agent-b",
      source: "api",
      format: "text",
      content: "please review",
      metadata: null,
      precedingMessages: [
        {
          id: "m1",
          senderId: "agent-a",
          source: "github",
          format: "card",
          content: githubCard,
          metadata: { systemSender: "github" },
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "m2",
          senderId: "agent-a",
          source: "gitlab",
          format: "card",
          content: gitlabCard,
          metadata: { systemSender: "gitlab" },
          createdAt: "2026-01-01T00:00:01.000Z",
        },
      ],
    };

    const out = await formatInboundContent(msg, cache);

    expect(out).toContain("[From: GitHub · type=system · sent=2026-01-01T00:00:00.000Z]");
    expect(out).toContain("[From: GitLab · type=system · sent=2026-01-01T00:00:01.000Z]");
    expect(out).toContain("[From: bob · type=agent]\n\nplease review");
  });

  it("omits the [Earlier in chat] block when precedingMessages is empty / absent", async () => {
    const sdk = mkSdk(async () => participants);
    const cache = createParticipantCache(sdk, "chat-1", () => {});
    const msg: SessionMessage = {
      id: "m1",
      chatId: "chat-1",
      senderId: "agent-a",
      format: "text",
      content: "hi",
      metadata: null,
      precedingMessages: [],
    };
    const out = await formatInboundContent(msg, cache);
    expect(out).toBe("[From: alice · type=agent]\n\nhi");
    expect(out).not.toContain("[Earlier in chat");
  });
});

describe("buildAgentEnv", () => {
  it("layers the four First Tree envelope vars on top of parent env (parent wins on unrelated keys)", () => {
    const parent = { PATH: "/usr/bin", FOO: "bar" } as NodeJS.ProcessEnv;
    const env = buildAgentEnv(parent, {
      sdk: { serverUrl: "http://first-tree" },
      agent: {
        agentId: "agent-a",
        inboxId: "inbox-a",
        displayName: "agent-a",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      chatId: "chat-1",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.FOO).toBe("bar");
    expect(env.FIRST_TREE_SERVER_URL).toBe("http://first-tree");
    expect(env.FIRST_TREE_AGENT_ID).toBe("agent-a");
    expect(env.FIRST_TREE_INBOX_ID).toBe("inbox-a");
    expect(env.FIRST_TREE_CHAT_ID).toBe("chat-1");
  });

  it("scrubs inherited runtime session token values and stale file paths", () => {
    const env = buildAgentEnv(
      {
        PATH: "/usr/bin",
        FIRST_TREE_RUNTIME_SESSION_TOKEN: "stale-runtime-token",
        FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE: "/tmp/stale-runtime-session-token",
      } as NodeJS.ProcessEnv,
      {
        sdk: { serverUrl: "http://first-tree", runtimeSessionToken: "runtime-token-1" },
        agent: {
          agentId: "agent-a",
          inboxId: "inbox-a",
          displayName: "agent-a",
          type: "agent",
          visibility: "organization",
          delegateMention: null,
          metadata: {},
        },
        chatId: "chat-1",
      },
    );

    expect(env.FIRST_TREE_RUNTIME_SESSION_TOKEN).toBeUndefined();
    expect(env.FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE).toBeUndefined();
  });

  it("replaces inherited runtime session env with the current token file", () => {
    const env = buildAgentEnv(
      {
        PATH: "/usr/bin",
        FIRST_TREE_RUNTIME_SESSION_TOKEN: "stale-runtime-token",
        FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE: "/tmp/stale-runtime-session-token",
      } as NodeJS.ProcessEnv,
      {
        sdk: { serverUrl: "http://first-tree", runtimeSessionToken: "runtime-token-1" },
        agent: {
          agentId: "agent-a",
          inboxId: "inbox-a",
          displayName: "agent-a",
          type: "agent",
          visibility: "organization",
          delegateMention: null,
          metadata: {},
        },
        chatId: "chat-1",
        runtimeSessionTokenFile: "/tmp/runtime-session-token",
      },
    );

    expect(env.FIRST_TREE_RUNTIME_SESSION_TOKEN).toBeUndefined();
    expect(env.FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE).toBe("/tmp/runtime-session-token");
  });

  it("adds client switch drain markers when provider context is available", () => {
    const env = buildAgentEnv({ PATH: "/usr/bin" } as NodeJS.ProcessEnv, {
      sdk: { serverUrl: "http://first-tree" },
      agent: {
        agentId: "agent-a",
        inboxId: "inbox-a",
        displayName: "agent-a",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      chatId: "chat-1",
      clientId: "client_aabbccdd",
      provider: "codex",
    });
    expect(env.FIRST_TREE_CLIENT_ID).toBe("client_aabbccdd");
    expect(env.FIRST_TREE_PROVIDER).toBe("codex");
    expect(env.FIRST_TREE_SWITCH_DRAIN_VERSION).toBe("1");
  });

  it("does not infer a CLI bin directory from FIRST_TREE_HOME", () => {
    const logs: string[] = [];
    const parent = {
      FIRST_TREE_HOME: "/first-tree-home",
      PATH: "/usr/bin",
    } as NodeJS.ProcessEnv;
    const env = buildAgentEnv(parent, {
      sdk: { serverUrl: "http://first-tree" },
      agent: {
        agentId: "agent-a",
        inboxId: "inbox-a",
        displayName: "agent-a",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      chatId: "chat-1",
      log: (msg) => logs.push(msg),
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(logs).toEqual([]);
  });

  it("prepends explicit FIRST_TREE_CLI_BIN_DIR to PATH for channel-local CLI resolution", () => {
    const parent = {
      FIRST_TREE_HOME: "/first-tree-home",
      FIRST_TREE_CLI_BIN_DIR: "/first-tree-cli-bin",
      PATH: `/usr/bin${delimiter}/first-tree-cli-bin${delimiter}/opt/bin`,
    } as NodeJS.ProcessEnv;
    const env = buildAgentEnv(parent, {
      sdk: { serverUrl: "http://first-tree" },
      agent: {
        agentId: "agent-a",
        inboxId: "inbox-a",
        displayName: "agent-a",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      chatId: "chat-1",
    });
    expect(env.PATH).toBe(`/first-tree-cli-bin${delimiter}/usr/bin${delimiter}/opt/bin`);
  });

  it("logs once when explicit FIRST_TREE_CLI_BIN_DIR lacks the channel binary", () => {
    setCliBinding({ binName: "first-tree-staging", packageName: "first-tree-staging" });
    const binDir = mkdtempSync(join(tmpdir(), "first-tree-agent-env-bin-"));
    const logs: string[] = [];
    const parent = { FIRST_TREE_CLI_BIN_DIR: binDir, PATH: "/usr/bin" } as NodeJS.ProcessEnv;
    const ctx = {
      sdk: { serverUrl: "http://first-tree" },
      agent: {
        agentId: "agent-a",
        inboxId: "inbox-a",
        displayName: "agent-a",
        type: "agent" as const,
        visibility: "organization" as const,
        delegateMention: null,
        metadata: {},
      },
      chatId: "chat-1",
      log: (msg: string) => logs.push(msg),
    };

    buildAgentEnv(parent, ctx);
    buildAgentEnv(parent, ctx);

    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("first-tree-staging");
    expect(logs[0]).toContain(binDir);
  });

  it("does not warn when explicit FIRST_TREE_CLI_BIN_DIR contains the channel binary", () => {
    setCliBinding({ binName: "first-tree-dev", packageName: null });
    const binDir = mkdtempSync(join(tmpdir(), "first-tree-agent-env-bin-"));
    mkdirSync(binDir, { recursive: true });
    const binPath = join(binDir, "first-tree-dev");
    writeFileSync(binPath, "#!/bin/sh\n");
    chmodSync(binPath, 0o755);
    const logs: string[] = [];

    buildAgentEnv({ FIRST_TREE_CLI_BIN_DIR: binDir, PATH: "/usr/bin" } as NodeJS.ProcessEnv, {
      sdk: { serverUrl: "http://first-tree" },
      agent: {
        agentId: "agent-a",
        inboxId: "inbox-a",
        displayName: "agent-a",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      chatId: "chat-1",
      log: (msg) => logs.push(msg),
    });

    expect(logs).toEqual([]);
  });

  it("overrides any pre-existing FIRST_TREE_* value in the parent env", () => {
    const parent = { FIRST_TREE_CHAT_ID: "wrong-chat" } as NodeJS.ProcessEnv;
    const env = buildAgentEnv(parent, {
      sdk: { serverUrl: "http://first-tree" },
      agent: {
        agentId: "agent-a",
        inboxId: "inbox-a",
        displayName: "agent-a",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      chatId: "chat-right",
    });
    expect(env.FIRST_TREE_CHAT_ID).toBe("chat-right");
  });

  it("injects BOTH wide (agent home) and narrow (legacy base) doc fences + workspaces root + slug for `chat send`", () => {
    // Wide-fence vars enable the new worktree-fence behaviour; the legacy
    // `FIRST_TREE_DOC_BASE` is kept emitting so a stale pre-fix `chat send`
    // binary inherited from this process still snapshots like it used to.
    const env = buildAgentEnv({} as NodeJS.ProcessEnv, {
      sdk: { serverUrl: "http://first-tree" },
      agent: {
        agentId: "agent-a",
        inboxId: "inbox-a",
        displayName: "agent-a",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      chatId: "chat-1",
      docContext: {
        // Source clones live under the `source-repos/` layer; the narrow base
        // is the source-repo top and the repo-local-path is agentHome-relative.
        base: "/ws/coder/source-repos/first-tree",
        agentHome: "/ws/coder",
        singleRepoLocalPath: "source-repos/first-tree",
        workspacesRoot: "/ws",
        selfSlug: "coder",
      },
    });
    expect(env.FIRST_TREE_DOC_BASE).toBe("/ws/coder/source-repos/first-tree");
    expect(env.FIRST_TREE_DOC_AGENT_HOME).toBe("/ws/coder");
    expect(env.FIRST_TREE_DOC_REPO_LOCAL_PATH).toBe("source-repos/first-tree");
    expect(env.FIRST_TREE_WORKSPACES_ROOT).toBe("/ws");
    expect(env.FIRST_TREE_AGENT_SLUG).toBe("coder");
  });

  it("omits FIRST_TREE_DOC_REPO_LOCAL_PATH when the agent has no single declared source repo", () => {
    // Zero / multi-repo agents have nothing to promote — the env var is
    // suppressed so chat-send doesn't try to derive a promotion prefix from
    // garbage and accidentally widen the fence in a different way.
    const env = buildAgentEnv({} as NodeJS.ProcessEnv, {
      sdk: { serverUrl: "http://first-tree" },
      agent: {
        agentId: "agent-a",
        inboxId: "inbox-a",
        displayName: "agent-a",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      chatId: "chat-1",
      docContext: { base: "/ws/coder", agentHome: "/ws/coder", workspacesRoot: "/ws", selfSlug: "coder" },
    });
    expect(env.FIRST_TREE_DOC_AGENT_HOME).toBe("/ws/coder");
    expect(env.FIRST_TREE_DOC_REPO_LOCAL_PATH).toBeUndefined();
  });

  it("omits doc-preview env vars when no docContext is provided (self-only / non-agent shells)", () => {
    const env = buildAgentEnv({} as NodeJS.ProcessEnv, {
      sdk: { serverUrl: "http://first-tree" },
      agent: {
        agentId: "agent-a",
        inboxId: "inbox-a",
        displayName: "agent-a",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      chatId: "chat-1",
    });
    expect(env.FIRST_TREE_DOC_BASE).toBeUndefined();
    expect(env.FIRST_TREE_DOC_AGENT_HOME).toBeUndefined();
    expect(env.FIRST_TREE_DOC_REPO_LOCAL_PATH).toBeUndefined();
    expect(env.FIRST_TREE_WORKSPACES_ROOT).toBeUndefined();
    expect(env.FIRST_TREE_AGENT_SLUG).toBeUndefined();
  });
});
