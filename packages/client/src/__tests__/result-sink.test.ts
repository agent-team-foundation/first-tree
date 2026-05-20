import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
  getDocumentBasePath?: () => Promise<string | null>;
};

function buildSink(fx: SinkFixtures) {
  const sendMessage = fx.sendMessage ?? vi.fn().mockResolvedValue(undefined);
  const logs: string[] = [];

  let trigger = fx.trigger;
  const sdk = {
    serverUrl: "http://test",
    sendMessage,
  } as unknown as FirstTreeHubSDK;

  const sink = createResultSink({
    sdk,
    agent: {
      agentId: ME,
      inboxId: "inbox-me",
      displayName: "test-agent",
      type: "autonomous_agent",
      delegateMention: null,
      metadata: {},
    },
    chatId: "chat-1",
    getTrigger: () => trigger,
    clearTrigger: () => {
      trigger = null;
    },
    log: (msg) => logs.push(msg),
    getDocumentBasePath: fx.getDocumentBasePath,
  });

  return { sink, sendMessage, logs };
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
    // Pin the bypass tag on the wire so AskUserQuestion + result-sink both
    // continue to land in group chats without 400s after改造 4 removed the
    // client-side mention auto-injection. Server匹配此 field 跳过
    // enforceGroupMention + 强制全员 notify=false.
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
      getDocumentBasePath: vi.fn().mockResolvedValue("first-tree-hub"),
    });

    await sink("see [design](docs/design.md)");

    const body = sendMessage.mock.calls[0]?.[1] as {
      metadata?: { documentContext?: unknown; mentions?: unknown };
    };
    expect(body.metadata?.documentContext).toBeUndefined();
    expect(body.metadata?.mentions).toBeUndefined();
  });

  describe("inline snapshot variant", () => {
    let worktree: string;

    beforeAll(async () => {
      worktree = await mkdtemp(join(tmpdir(), "result-sink-snapshot-"));
      await writeFile(join(worktree, "design.md"), "# design\n\nbody.\n", "utf8");
      await writeFile(join(worktree, "api.md"), "# api\n", "utf8");
      await mkdir(join(worktree, "docs"), { recursive: true });
      await writeFile(join(worktree, "docs", "intro.md"), "# intro\n", "utf8");
      // For symlink escape test: a "public" link whose realpath actually lives
      // inside `.agent/`.
      await mkdir(join(worktree, ".agent"), { recursive: true });
      await writeFile(join(worktree, ".agent", "secret.md"), "# secret\n", "utf8");
      await symlink(join(worktree, ".agent", "secret.md"), join(worktree, "public.md"));
    });

    afterAll(async () => {
      await rm(worktree, { recursive: true, force: true });
    });

    it("emits kind=snapshot when basePath resolves and the text references a real .md", async () => {
      const { sink, sendMessage } = buildSink({
        trigger: { messageId: "m1", senderId: "agent-peer" },
        getDocumentBasePath: vi.fn().mockResolvedValue(worktree),
      });

      await sink("see [design](design.md)");

      const body = sendMessage.mock.calls[0]?.[1] as {
        metadata?: {
          documentContext?: {
            kind?: string;
            docs?: Array<{ path: string; content: string; size: number; sha256: string }>;
          };
        };
      };
      expect(body.metadata?.documentContext?.kind).toBe("snapshot");
      expect(body.metadata?.documentContext?.docs).toHaveLength(1);
      const [doc] = body.metadata?.documentContext?.docs ?? [];
      expect(doc?.path).toBe("design.md");
      expect(doc?.content).toBe("# design\n\nbody.\n");
      expect(doc?.size).toBe(16);
      expect(doc?.sha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it("emits kind=snapshot for a bare `.md` mention (no inline markdown link wrapping)", async () => {
      // Web-side `linkifyMarkdownDocPaths` wraps the same bare token as
      // `[design.md](design.md)` before rendering — both sides must produce
      // the same canonical key so the click hits the snapshot in cache.
      const { sink, sendMessage } = buildSink({
        trigger: { messageId: "m1", senderId: "agent-peer" },
        getDocumentBasePath: vi.fn().mockResolvedValue(worktree),
      });

      await sink("created design.md just now");

      const body = sendMessage.mock.calls[0]?.[1] as {
        metadata?: { documentContext?: { kind?: string; docs?: Array<{ path: string }> } };
      };
      expect(body.metadata?.documentContext?.kind).toBe("snapshot");
      expect(body.metadata?.documentContext?.docs?.map((d) => d.path)).toEqual(["design.md"]);
    });

    it("strips :line[:col] from bare paths so snapshot keys match what the click handler resolves", async () => {
      const { sink, sendMessage } = buildSink({
        trigger: { messageId: "m1", senderId: "agent-peer" },
        getDocumentBasePath: vi.fn().mockResolvedValue(worktree),
      });

      await sink("see docs/intro.md:42:1 for details");

      const body = sendMessage.mock.calls[0]?.[1] as {
        metadata?: { documentContext?: { kind?: string; docs?: Array<{ path: string }> } };
      };
      expect(body.metadata?.documentContext?.docs?.map((d) => d.path)).toEqual(["docs/intro.md"]);
    });

    it("rejects dotfiles / hidden dirs and attaches NO documentContext when no docs survive", async () => {
      const { sink, sendMessage } = buildSink({
        trigger: { messageId: "m1", senderId: "agent-peer" },
        getDocumentBasePath: vi.fn().mockResolvedValue(worktree),
      });

      await sink("hidden: [secret](.agent/secret.md)");

      const body = sendMessage.mock.calls[0]?.[1] as {
        metadata?: { documentContext?: unknown };
      };
      // The hidden path is rejected, leaving zero snapshots — and we no longer
      // emit the legacy `kind:"path"` fallback (which would leak the worktree
      // absolute path into history), so there is no documentContext at all.
      expect(body.metadata?.documentContext).toBeUndefined();
    });

    it("stores canonical workspace-relative paths so web cache lookup matches", async () => {
      // `./docs/intro.md` and `docs/intro.md` should both store as `docs/intro.md`,
      // matching what `docPreviewPathFromHref` produces for a click.
      const { sink, sendMessage } = buildSink({
        trigger: { messageId: "m1", senderId: "agent-peer" },
        getDocumentBasePath: vi.fn().mockResolvedValue(worktree),
      });

      await sink("see [a](./docs/intro.md) and [b](./other/../docs/intro.md)");

      const body = sendMessage.mock.calls[0]?.[1] as {
        metadata?: {
          documentContext?: {
            docs?: Array<{ path: string }>;
          };
        };
      };
      const paths = body.metadata?.documentContext?.docs?.map((d) => d.path) ?? [];
      expect(paths).toEqual(["docs/intro.md"]);
    });

    it("rejects symlinks whose realpath crosses into a hidden directory", async () => {
      // public.md is a symlink → .agent/secret.md. Link-path segments alone
      // would pass; realpath-relative segments must fail.
      const { sink, sendMessage } = buildSink({
        trigger: { messageId: "m1", senderId: "agent-peer" },
        getDocumentBasePath: vi.fn().mockResolvedValue(worktree),
      });

      await sink("see [public](public.md)");

      const body = sendMessage.mock.calls[0]?.[1] as {
        metadata?: { documentContext?: unknown };
      };
      // Symlink target is rejected → zero snapshots → no documentContext (the
      // legacy kind:"path" fallback that leaked the worktree path is gone).
      expect(body.metadata?.documentContext).toBeUndefined();
    });

    it("stores size that matches Buffer.byteLength(content, utf8) so server validation never rejects a malformed-UTF-8 file", async () => {
      // Reviewer-flagged regression: when a `.md` file contains invalid
      // UTF-8 bytes, `buf.toString("utf8")` substitutes U+FFFD, so the raw
      // byte length drifts from the re-encoded byte length. If runtime
      // ships raw bytes as `size` but server recomputes from `content`,
      // sendMessage fails with BadRequestError("size does not match
      // content"). Pin runtime + server to the SAME algorithm so a
      // broken-encoding markdown file degrades to a preview-with-FFFD
      // rather than a hard send failure.
      const malformed = Buffer.concat([
        Buffer.from("# title\n", "utf8"),
        Buffer.from([0xff, 0xfe, 0xfd]), // invalid UTF-8 bytes
      ]);
      await writeFile(join(worktree, "broken.md"), malformed);

      const { sink, sendMessage } = buildSink({
        trigger: { messageId: "m1", senderId: "agent-peer" },
        getDocumentBasePath: vi.fn().mockResolvedValue(worktree),
      });

      await sink("see [broken](broken.md)");

      const body = sendMessage.mock.calls[0]?.[1] as {
        metadata?: {
          documentContext?: {
            docs?: Array<{ path: string; content: string; size: number }>;
          };
        };
      };
      const [doc] = body.metadata?.documentContext?.docs ?? [];
      expect(doc?.path).toBe("broken.md");
      // The cardinal invariant: declared size MUST equal the server's
      // recomputation of Buffer.byteLength(content, "utf8").
      expect(doc?.size).toBe(Buffer.byteLength(doc?.content ?? "", "utf8"));
    });

    it("ignores external-link hrefs (https / mailto / scheme-relative) even when a matching file exists on disk", async () => {
      // Defence in depth: if an agent emits `[doc](https://x.com/api.md)` and
      // the workspace happens to contain `https:/x.com/api.md`, the runtime
      // must NOT canonicalise the URL into a workspace path. We pre-create
      // that exact path to prove the guard is structural and not just
      // accidentally-by-missing-file.
      await mkdir(join(worktree, "https:", "x.com"), { recursive: true });
      await writeFile(join(worktree, "https:", "x.com", "api.md"), "# evil\n", "utf8");

      const { sink, sendMessage } = buildSink({
        trigger: { messageId: "m1", senderId: "agent-peer" },
        getDocumentBasePath: vi.fn().mockResolvedValue(worktree),
      });

      await sink("see [evil](https://x.com/api.md) and [also](//x.com/a.md) and [mail](mailto:a@b.md)");

      const body = sendMessage.mock.calls[0]?.[1] as {
        metadata?: { documentContext?: unknown };
      };
      // None of the three hrefs is a workspace path → zero snapshots → no
      // documentContext (no legacy kind:"path" fallback).
      expect(body.metadata?.documentContext).toBeUndefined();
    });

    it("ignores escaped link `\\[...](path.md)` and image link `![alt](path.md)`", async () => {
      const { sink, sendMessage } = buildSink({
        trigger: { messageId: "m1", senderId: "agent-peer" },
        getDocumentBasePath: vi.fn().mockResolvedValue(worktree),
      });

      await sink("escaped: \\[design](design.md) and image: ![diagram](api.md)");

      const body = sendMessage.mock.calls[0]?.[1] as {
        metadata?: { documentContext?: unknown };
      };
      // Neither escaped nor image triggers snapshot emission → zero snapshots
      // → no documentContext (no legacy kind:"path" fallback).
      expect(body.metadata?.documentContext).toBeUndefined();
    });

    it("sends content with absolute-in-root paths rewritten to relative (Option R wiring)", async () => {
      // The sink must forward `rewrittenText`, not the agent's original body, so
      // web's unchanged re-scan sees a relative token and matches the snapshot.
      const { sink, sendMessage } = buildSink({
        trigger: { messageId: "m1", senderId: "agent-peer" },
        getDocumentBasePath: vi.fn().mockResolvedValue(worktree),
      });

      const abs = join(worktree, "design.md");
      await sink(`done — wrote ${abs} for review`);

      const [, body] = sendMessage.mock.calls[0] ?? [];
      const sent = body as {
        content?: string;
        metadata?: { documentContext?: { docs?: Array<{ path: string }> } };
      };
      expect(sent.content).toBe("done — wrote design.md for review");
      expect(sent.metadata?.documentContext?.docs?.map((d) => d.path)).toEqual(["design.md"]);
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
          type: "autonomous_agent",
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
        type: "autonomous_agent",
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
