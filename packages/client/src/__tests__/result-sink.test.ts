import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SelfFence } from "../runtime/doc-snapshots.js";
import { createResultSink, type Trigger } from "../runtime/result-sink.js";
import type { FirstTreeHubSDK } from "../sdk.js";

/**
 * Contract tests for the forward-to-chat sink (runtime-owned, handler-agnostic).
 *
 * v1 §四 改造 4: the trigger-sender mention auto-injection branch was
 * deleted to break the agent ↔ agent echo loop. These tests pin:
 *
 *   1. final-text deliveries no longer inject `metadata.mentions`
 *      (case 1, case 5);
 *   2. the documentContext metadata branch (PR #356) is preserved
 *      (case 1.5 — the v1.5 regression guard);
 *   3. silent-turn + `inReplyTo` invariants survive (case 2 / case 3);
 *   4. `chat send <target>` wake-ups stay outside this sink (server side).
 */

const ME = "agent-me";

type SinkFixtures = {
  trigger: Trigger | null;
  sendMessage?: ReturnType<typeof vi.fn>;
  getSelfFence?: () => Promise<SelfFence | null>;
  /** Defaults to a real org id so doc capture is enabled when a self-fence is
   *  also provided. Pass `null` to disable capture. */
  orgId?: string | null;
};

const FAKE_ORG_ID = "11111111-1111-4111-8111-111111111111";

function fakeUploadId(seq: number): string {
  return `00000000-0000-4000-8000-${seq.toString(16).padStart(12, "0")}`;
}

function buildSink(fx: SinkFixtures) {
  const sendMessage = fx.sendMessage ?? vi.fn().mockResolvedValue(undefined);
  const logs: string[] = [];

  let trigger = fx.trigger;
  let seq = 0;
  // Stub the SDK upload the sink calls during doc capture; mints deterministic
  // uuid-shaped ids so the rewritten `attachment:<id>` links are assertable.
  const uploadAttachment = vi.fn(
    async (o: { bytes: Uint8Array | Buffer; mimeType: string; filename: string; orgId: string }) => {
      seq += 1;
      const bytes = Buffer.from(o.bytes);
      return { id: fakeUploadId(seq), mimeType: o.mimeType, filename: o.filename, sizeBytes: bytes.byteLength };
    },
  );
  const sdk = {
    serverUrl: "http://test",
    sendMessage,
    uploadAttachment,
  } as unknown as FirstTreeHubSDK;

  const orgId = fx.orgId === undefined ? FAKE_ORG_ID : fx.orgId;

  const sink = createResultSink({
    sdk,
    agent: {
      agentId: ME,
      inboxId: "inbox-me",
      displayName: "test-agent",
      type: "agent",
      visibility: "organization",
      delegateMention: null,
      metadata: {},
    },
    chatId: "chat-1",
    getTrigger: () => trigger,
    clearTrigger: () => {
      trigger = null;
    },
    log: (msg) => logs.push(msg),
    getSelfFence: fx.getSelfFence,
    getOrgId: async () => orgId,
  });

  return { sink, sendMessage, uploadAttachment, logs };
}

describe("createResultSink — forwardResult enrichment", () => {
  it("case 1: non-empty output WITHOUT documentBasePath omits metadata entirely (no mention auto-injection)", async () => {
    // v1 §四 改造 4: trigger-sender mention is no longer injected here.
    // Without a documentBasePath there's nothing else for buildMetadata to
    // contribute, so metadata is left off the wire.
    const { sink, sendMessage } = buildSink({
      trigger: { messageId: "m1", senderId: "agent-peer" },
    });

    await sink("final answer");

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, body] = sendMessage.mock.calls[0] ?? [];
    expect(chatId).toBe("chat-1");
    expect(body).toMatchObject({ format: "text", content: "final answer", inReplyTo: "m1" });
    expect((body as Record<string, unknown>).metadata).toBeUndefined();
    // v1 §四 改造 4 (b): final text always carries `purpose: "agent-final-text"`
    // so server bypasses enforceGroupMention + fan-out is forced notify=false.
    expect((body as Record<string, unknown>).purpose).toBe("agent-final-text");
  });

  it('every forward carries `purpose: "agent-final-text"` — server uses it to bypass group-chat mention enforcement', async () => {
    // Pin the bypass tag on the wire so result-sink forwards continue to
    // land in group chats without 400s after改造 4 removed the client-side
    // mention auto-injection. Server匹配此 field 跳过 enforceGroupMention +
    // 强制全员 notify=false.
    const { sink, sendMessage } = buildSink({ trigger: null });

    await sink("turn ended");

    const body = sendMessage.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.purpose).toBe("agent-final-text");
  });

  it("case 1.5: a base path that resolves no docs attaches NO documentContext (no kind:path leak)", async () => {
    // The basePath here is a relative string that won't resolve to a real
    // worktree on disk, so the snapshot scan returns no docs. We no longer
    // fall back to the legacy `kind:"path"` variant — it would embed the
    // agent host's local absolute path in immutable history and is dead in
    // the cloud topology. A message with no resolvable doc carries no
    // documentContext at all (and still no auto-mentions array).
    const { sink, sendMessage } = buildSink({
      trigger: { messageId: "m1", senderId: "agent-peer" },
      getSelfFence: vi.fn().mockResolvedValue({ agentHome: "first-tree" } satisfies SelfFence),
    });

    await sink("see [design](docs/design.md)");

    const body = sendMessage.mock.calls[0]?.[1] as {
      metadata?: { documentContext?: unknown; mentions?: unknown };
    };
    expect(body.metadata?.documentContext).toBeUndefined();
    expect(body.metadata?.mentions).toBeUndefined();
  });

  describe("attachment-ref capture variant", () => {
    let worktree: string;

    beforeAll(async () => {
      worktree = await mkdtemp(join(tmpdir(), "result-sink-snapshot-"));
      await writeFile(join(worktree, "design.md"), "# design\n\nbody.\n", "utf8");
      await writeFile(join(worktree, "api.md"), "# api\n", "utf8");
      await mkdir(join(worktree, "docs"), { recursive: true });
      await writeFile(join(worktree, "docs", "intro.md"), "# intro\n", "utf8");
      await mkdir(join(worktree, ".agent"), { recursive: true });
      await writeFile(join(worktree, ".agent", "secret.md"), "# secret\n", "utf8");
      await symlink(join(worktree, ".agent", "secret.md"), join(worktree, "public.md"));
    });

    afterAll(async () => {
      await rm(worktree, { recursive: true, force: true });
    });

    it("attaches an AttachmentRef and rewrites to an attachment link when a real .md is referenced", async () => {
      const { sink, sendMessage, uploadAttachment } = buildSink({
        trigger: { messageId: "m1", senderId: "agent-peer" },
        getSelfFence: vi.fn().mockResolvedValue({ agentHome: worktree } satisfies SelfFence),
      });

      await sink("see [design](design.md)");

      const body = sendMessage.mock.calls[0]?.[1] as {
        content?: string;
        metadata?: { attachments?: Array<{ kind: string; source?: { path: string }; sha256?: string; size: number }> };
      };
      expect(body.metadata?.attachments).toHaveLength(1);
      const [ref] = body.metadata?.attachments ?? [];
      expect(ref?.kind).toBe("document");
      expect(ref?.source?.path).toBe("design.md");
      expect(ref?.size).toBe(16);
      expect(ref?.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(body.content).toBe(`see [design](attachment:${fakeUploadId(1)})`);
      expect(uploadAttachment).toHaveBeenCalledTimes(1);
    });

    it("captures a bare `.md` mention and rewrites it to an explicit attachment link", async () => {
      const { sink, sendMessage } = buildSink({
        trigger: { messageId: "m1", senderId: "agent-peer" },
        getSelfFence: vi.fn().mockResolvedValue({ agentHome: worktree } satisfies SelfFence),
      });

      await sink("created design.md just now");

      const body = sendMessage.mock.calls[0]?.[1] as {
        content?: string;
        metadata?: { attachments?: Array<{ source?: { path: string } }> };
      };
      expect(body.metadata?.attachments?.map((a) => a.source?.path)).toEqual(["design.md"]);
      expect(body.content).toBe(`created [design.md](attachment:${fakeUploadId(1)}) just now`);
    });

    it("disables capture (no attachments) when the org id is unresolvable", async () => {
      const { sink, sendMessage, uploadAttachment } = buildSink({
        trigger: { messageId: "m1", senderId: "agent-peer" },
        getSelfFence: vi.fn().mockResolvedValue({ agentHome: worktree } satisfies SelfFence),
        orgId: null,
      });

      await sink("see [design](design.md)");

      const body = sendMessage.mock.calls[0]?.[1] as { content?: string; metadata?: unknown };
      expect(body.metadata).toBeUndefined();
      // Body untouched — the mention stays plain text.
      expect(body.content).toBe("see [design](design.md)");
      expect(uploadAttachment).not.toHaveBeenCalled();
    });

    it("rejects dotfiles / hidden dirs and attaches no metadata when nothing survives", async () => {
      const { sink, sendMessage } = buildSink({
        trigger: { messageId: "m1", senderId: "agent-peer" },
        getSelfFence: vi.fn().mockResolvedValue({ agentHome: worktree } satisfies SelfFence),
      });

      await sink("hidden: [secret](.agent/secret.md)");

      const body = sendMessage.mock.calls[0]?.[1] as { metadata?: { attachments?: unknown } };
      expect(body.metadata?.attachments).toBeUndefined();
    });

    it("emits failedMentions for unresolved bare doc mentions", async () => {
      const { sink, sendMessage } = buildSink({
        trigger: { messageId: "m1", senderId: "agent-peer" },
        getSelfFence: vi.fn().mockResolvedValue({ agentHome: worktree } satisfies SelfFence),
      });

      await sink("missing reference: docs/missing.md");

      const body = sendMessage.mock.calls[0]?.[1] as {
        metadata?: { documentContext?: { failedMentions?: Array<{ raw: string; reason: string }> } };
      };
      expect(body.metadata?.documentContext?.failedMentions).toEqual([{ raw: "docs/missing.md", reason: "missing" }]);
    });

    it("stores canonical workspace-relative source paths", async () => {
      const { sink, sendMessage } = buildSink({
        trigger: { messageId: "m1", senderId: "agent-peer" },
        getSelfFence: vi.fn().mockResolvedValue({ agentHome: worktree } satisfies SelfFence),
      });

      await sink("see [a](./docs/intro.md) and [b](./other/../docs/intro.md)");

      const body = sendMessage.mock.calls[0]?.[1] as {
        metadata?: { attachments?: Array<{ source?: { path: string } }> };
      };
      expect(body.metadata?.attachments?.map((a) => a.source?.path)).toEqual(["docs/intro.md"]);
    });

    it("rejects symlinks whose realpath crosses into a hidden directory", async () => {
      const { sink, sendMessage } = buildSink({
        trigger: { messageId: "m1", senderId: "agent-peer" },
        getSelfFence: vi.fn().mockResolvedValue({ agentHome: worktree } satisfies SelfFence),
      });

      await sink("see [public](public.md)");

      const body = sendMessage.mock.calls[0]?.[1] as { metadata?: { attachments?: unknown } };
      expect(body.metadata?.attachments).toBeUndefined();
    });

    it("ref size matches Buffer.byteLength(content, utf8) for a malformed-UTF-8 file (server size check)", async () => {
      const malformed = Buffer.concat([Buffer.from("# title\n", "utf8"), Buffer.from([0xff, 0xfe, 0xfd])]);
      await writeFile(join(worktree, "broken.md"), malformed);
      const expectedSize = Buffer.byteLength(Buffer.from(malformed).toString("utf8"), "utf8");

      const { sink, sendMessage } = buildSink({
        trigger: { messageId: "m1", senderId: "agent-peer" },
        getSelfFence: vi.fn().mockResolvedValue({ agentHome: worktree } satisfies SelfFence),
      });

      await sink("see [broken](broken.md)");

      const body = sendMessage.mock.calls[0]?.[1] as {
        metadata?: { attachments?: Array<{ source?: { path: string }; size: number }> };
      };
      const [ref] = body.metadata?.attachments ?? [];
      expect(ref?.source?.path).toBe("broken.md");
      expect(ref?.size).toBe(expectedSize);
    });

    it("ignores external-link hrefs even when a matching file exists on disk", async () => {
      await mkdir(join(worktree, "https:", "x.com"), { recursive: true });
      await writeFile(join(worktree, "https:", "x.com", "api.md"), "# evil\n", "utf8");

      const { sink, sendMessage } = buildSink({
        trigger: { messageId: "m1", senderId: "agent-peer" },
        getSelfFence: vi.fn().mockResolvedValue({ agentHome: worktree } satisfies SelfFence),
      });

      await sink("see [evil](https://x.com/api.md) and [also](//x.com/a.md) and [mail](mailto:a@b.md)");

      const body = sendMessage.mock.calls[0]?.[1] as { metadata?: { attachments?: unknown } };
      expect(body.metadata?.attachments).toBeUndefined();
    });

    it("ignores escaped link `\\[...](path.md)` and image link `![alt](path.md)`", async () => {
      const { sink, sendMessage } = buildSink({
        trigger: { messageId: "m1", senderId: "agent-peer" },
        getSelfFence: vi.fn().mockResolvedValue({ agentHome: worktree } satisfies SelfFence),
      });

      await sink("escaped: \\[design](design.md) and image: ![diagram](api.md)");

      const body = sendMessage.mock.calls[0]?.[1] as { metadata?: { attachments?: unknown } };
      expect(body.metadata?.attachments).toBeUndefined();
    });

    it("forwards the rewritten body (not the original) so web renders the attachment link", async () => {
      const { sink, sendMessage } = buildSink({
        trigger: { messageId: "m1", senderId: "agent-peer" },
        getSelfFence: vi.fn().mockResolvedValue({ agentHome: worktree } satisfies SelfFence),
      });

      const abs = join(worktree, "design.md");
      await sink(`done — wrote ${abs} for review`);

      const [, body] = sendMessage.mock.calls[0] ?? [];
      const sent = body as { content?: string; metadata?: { attachments?: Array<{ source?: { path: string } }> } };
      expect(sent.content).toBe(`done — wrote [design.md](attachment:${fakeUploadId(1)}) for review`);
      expect(sent.metadata?.attachments?.map((a) => a.source?.path)).toEqual(["design.md"]);
    });
  });

  it("case 3: inReplyTo is set from the current trigger (InReplyTo-required)", async () => {
    const { sink, sendMessage } = buildSink({
      trigger: { messageId: "m-abc", senderId: "agent-peer" },
    });

    await sink("final answer");

    const body = sendMessage.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.inReplyTo).toBe("m-abc");
  });

  it("case 3b: no inReplyTo when there's no current trigger (unprompted forward)", async () => {
    const { sink, sendMessage } = buildSink({ trigger: null });

    await sink("status update");

    const body = sendMessage.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.inReplyTo).toBeUndefined();
    expect(body.metadata).toBeUndefined();
  });

  it("case 5: never emits self-mention even when trigger senderId == own agentId", async () => {
    // Defensive: server-side filtering usually drops self-fanouts, but the
    // sink must degrade gracefully without emitting self-mentions.
    const { sink, sendMessage } = buildSink({
      trigger: { messageId: "m-self", senderId: ME },
    });

    await sink("status update");

    const body = sendMessage.mock.calls[0]?.[1] as { metadata?: { mentions?: unknown } };
    expect(body.metadata).toBeUndefined();
  });

  it("does NOT itself parse `@name` tokens from the reply — server is authoritative", async () => {
    // `@name` → agentId resolution lives server-side in sendMessage (see
    // services/message.ts). The sink contributes no mention metadata at all
    // after改造 4. Any token resolution that happens is the server's job.
    const { sink, sendMessage } = buildSink({
      trigger: { messageId: "m3", senderId: "agent-peer" },
    });

    await sink("planning: @obs please double-check");

    const body = sendMessage.mock.calls[0]?.[1] as { metadata?: { mentions?: unknown } };
    expect(body.metadata).toBeUndefined();
  });

  describe("case 2: silent-turn protocol — empty output skips delivery", () => {
    it("skips sendMessage when the agent produces an empty string", async () => {
      const { sink, sendMessage, logs } = buildSink({
        trigger: { messageId: "m-silent", senderId: "agent-peer" },
      });

      await sink("");

      expect(sendMessage).not.toHaveBeenCalled();
      expect(logs.some((l) => l.includes("silent turn"))).toBe(true);
    });

    it("skips sendMessage when the agent produces whitespace-only output", async () => {
      const { sink, sendMessage, logs } = buildSink({
        trigger: { messageId: "m-ws", senderId: "agent-peer" },
      });

      await sink("   \n\t  ");

      expect(sendMessage).not.toHaveBeenCalled();
      expect(logs.some((l) => l.includes("silent turn"))).toBe(true);
    });

    it("does NOT skip when the agent produces any non-empty content (no length filtering)", async () => {
      // Single-character replies, short statuses, and any non-empty content
      // must pass through untouched — the runtime never evaluates "is this
      // meaningful?". That's the agent's call (via prompt), not code's.
      const { sink, sendMessage } = buildSink({
        trigger: { messageId: "m-short", senderId: "agent-peer" },
      });

      await sink(".");

      expect(sendMessage).toHaveBeenCalledTimes(1);
    });

    it("clears the trigger on silent turn so the next inbound message isn't accidentally still bound", async () => {
      let trigger: Trigger | null = { messageId: "m-clear", senderId: "agent-peer" };
      const observedTrigger: (Trigger | null)[] = [];
      const sdk = {
        serverUrl: "http://test",
        sendMessage: vi.fn().mockResolvedValue(undefined),
      } as unknown as FirstTreeHubSDK;
      const sink = createResultSink({
        sdk,
        agent: {
          agentId: ME,
          inboxId: "inbox-me",
          displayName: "test-agent",
          type: "agent",
          visibility: "organization",
          delegateMention: null,
          metadata: {},
        },
        chatId: "chat-1",
        getTrigger: () => trigger,
        clearTrigger: () => {
          observedTrigger.push(trigger);
          trigger = null;
        },
        log: () => {},
      });

      await sink("");

      expect(observedTrigger).toHaveLength(1);
      expect(observedTrigger[0]?.messageId).toBe("m-clear");
      expect(trigger).toBeNull();
    });
  });

  it("clears the trigger before awaiting sendMessage so a concurrent inject-driven trigger isn't consumed", async () => {
    let trigger: Trigger | null = { messageId: "m-current", senderId: "agent-peer" };
    const observedTriggers: (Trigger | null)[] = [];
    const sendMessage = vi.fn().mockImplementation(async () => {
      observedTriggers.push(trigger);
    });

    const sdkForRace = {
      serverUrl: "http://test",
      sendMessage,
    } as unknown as FirstTreeHubSDK;
    const sink = createResultSink({
      sdk: sdkForRace,
      agent: {
        agentId: ME,
        inboxId: "inbox-me",
        displayName: "test-agent",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      chatId: "chat-1",
      getTrigger: () => trigger,
      clearTrigger: () => {
        trigger = null;
      },
      log: () => {},
    });

    const done = sink("reply text");
    trigger = { messageId: "m-next", senderId: "agent-other" };
    await done;

    const body = sendMessage.mock.calls[0]?.[1] as { inReplyTo?: string };
    expect(body.inReplyTo).toBe("m-current");
    expect(observedTriggers[0]?.messageId).toBe("m-next");
  });
});
