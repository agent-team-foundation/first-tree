import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeConfigPayload } from "@first-tree/shared";
import { describe, expect, it, vi } from "vitest";
import type { GitMirrorManager, SourceRepoOutcome } from "../runtime/git-mirror-manager.js";
import type { SessionContext } from "../runtime/handler.js";
import { prepareSourceRepos, releaseSourceReposForSession } from "../runtime/source-repos.js";

/**
 * Decision-B "live use" registry semantics (per-agent-source-repo). These are
 * pure in-process bookkeeping tests — the GitMirrorManager is mocked so we can
 * observe the `activelyInUse` flag each `ensureSourceRepo` call receives without
 * touching git.
 */

type EnsureArgs = Parameters<GitMirrorManager["ensureSourceRepo"]>[0];

function makeManager(opts?: { onEnsure?: (args: EnsureArgs) => void; throwOnCall?: number }): {
  manager: GitMirrorManager;
  calls: EnsureArgs[];
} {
  const calls: EnsureArgs[] = [];
  const manager = {
    ensureSourceRepo: vi.fn(async (args: EnsureArgs) => {
      calls.push(args);
      opts?.onEnsure?.(args);
      if (opts?.throwOnCall && calls.length === opts.throwOnCall) {
        throw new Error("clone failed");
      }
      return {
        clonePath: args.clonePath,
        headCommit: "deadbeef",
        branch: "main",
        outcome: "cloned" as SourceRepoOutcome,
      };
    }),
    removeSourceRepo: vi.fn(async () => {}),
    sweepLegacyMirrors: vi.fn(async () => ({ removed: [] })),
    legacyMirrorsRoot: "/tmp/legacy",
  } as unknown as GitMirrorManager;
  return { manager, calls };
}

function makeCtx(chatId: string): SessionContext {
  return { chatId, log: vi.fn(), agent: { agentId: "agent-x" } } as unknown as SessionContext;
}

function payloadFor(localPath: string): AgentRuntimeConfigPayload {
  return { gitRepos: [{ url: "git@github.com:example/repo.git", localPath }] } as unknown as AgentRuntimeConfigPayload;
}

// Unique workspace per test so the module-level registry (keyed by absolute
// path) never collides across tests in this file.
let n = 0;
function freshWorkspace(): string {
  n += 1;
  return join(tmpdir(), `ftt-srcrepo-reg-${n}`);
}

describe("source-repos live-use registry (decision B, keyed by chatId)", () => {
  it("a second concurrent chat on the same checkout is told it is in use; releasing the first clears it", async () => {
    const workspace = freshWorkspace();
    const { manager, calls } = makeManager();
    const ctxA = makeCtx("chat-A");
    const ctxB = makeCtx("chat-B");

    await prepareSourceRepos({
      workspace,
      payload: payloadFor("repo"),
      sessionCtx: ctxA,
      gitMirrorManager: manager,
      agentName: null,
    });
    expect(calls.at(-1)?.activelyInUse).toBe(false); // first chat — nobody else

    await prepareSourceRepos({
      workspace,
      payload: payloadFor("repo"),
      sessionCtx: ctxB,
      gitMirrorManager: manager,
      agentName: null,
    });
    expect(calls.at(-1)?.activelyInUse).toBe(true); // chat-A still live

    releaseSourceReposForSession(ctxA);

    await prepareSourceRepos({
      workspace,
      payload: payloadFor("repo"),
      sessionCtx: ctxB,
      gitMirrorManager: manager,
      agentName: null,
    });
    expect(calls.at(-1)?.activelyInUse).toBe(false); // only chat-B now

    releaseSourceReposForSession(ctxB);
  });

  it("start → resume of the SAME chat (fresh SessionContext, same chatId) does not leak — one release clears it", async () => {
    const workspace = freshWorkspace();
    const { manager, calls } = makeManager();
    // Two distinct SessionContext objects, same chatId — models the runtime
    // handing a fresh ctx to each resume.
    const start = makeCtx("chat-A");
    const resume = makeCtx("chat-A");
    const other = makeCtx("chat-B");

    await prepareSourceRepos({
      workspace,
      payload: payloadFor("repo"),
      sessionCtx: start,
      gitMirrorManager: manager,
      agentName: null,
    });
    await prepareSourceRepos({
      workspace,
      payload: payloadFor("repo"),
      sessionCtx: resume,
      gitMirrorManager: manager,
      agentName: null,
    });

    // A different chat sees exactly ONE other live chat (chat-A), not two.
    await prepareSourceRepos({
      workspace,
      payload: payloadFor("repo"),
      sessionCtx: other,
      gitMirrorManager: manager,
      agentName: null,
    });
    expect(calls.at(-1)?.activelyInUse).toBe(true);
    releaseSourceReposForSession(other);

    // A single release of chat-A (object identity irrelevant — keyed by chatId)
    // fully clears it; the next chat sees the checkout free.
    releaseSourceReposForSession(resume);
    const after = makeCtx("chat-C");
    await prepareSourceRepos({
      workspace,
      payload: payloadFor("repo"),
      sessionCtx: after,
      gitMirrorManager: manager,
      agentName: null,
    });
    expect(calls.at(-1)?.activelyInUse).toBe(false);
    releaseSourceReposForSession(after);
  });

  it("a failed start releases its registration so it does not pin future sessions", async () => {
    const workspace = freshWorkspace();
    const { manager, calls } = makeManager({ throwOnCall: 1 });
    const failing = makeCtx("chat-A");

    await expect(
      prepareSourceRepos({
        workspace,
        payload: payloadFor("repo"),
        sessionCtx: failing,
        gitMirrorManager: manager,
        agentName: null,
      }),
    ).rejects.toThrow("clone failed");

    // A later chat must NOT see the dead chat-A as a live user.
    const next = makeCtx("chat-B");
    await prepareSourceRepos({
      workspace,
      payload: payloadFor("repo"),
      sessionCtx: next,
      gitMirrorManager: manager,
      agentName: null,
    });
    expect(calls.at(-1)?.activelyInUse).toBe(false);
    releaseSourceReposForSession(next);
  });

  it("a transient failure on a re-acquire (resume) does NOT deregister a still-live chat", async () => {
    const workspace = freshWorkspace();
    // Throw on the SECOND ensureSourceRepo call (the chat's resume), not the first (start).
    const { manager, calls } = makeManager({ throwOnCall: 2 });
    const live = makeCtx("chat-A");

    // Start succeeds → chat-A registered + live.
    await prepareSourceRepos({
      workspace,
      payload: payloadFor("repo"),
      sessionCtx: live,
      gitMirrorManager: manager,
      agentName: null,
    });

    // Resume (fresh SessionContext, same chatId) fails transiently. Because the
    // chat was ALREADY registered (firstRegistration=false), the failure must
    // NOT roll back its liveness — the session manager keeps it alive for retry.
    const resume = makeCtx("chat-A");
    await expect(
      prepareSourceRepos({
        workspace,
        payload: payloadFor("repo"),
        sessionCtx: resume,
        gitMirrorManager: manager,
        agentName: null,
      }),
    ).rejects.toThrow("clone failed");

    // A concurrent chat must STILL see chat-A as a live user → not safe to reset.
    const other = makeCtx("chat-B");
    await prepareSourceRepos({
      workspace,
      payload: payloadFor("repo"),
      sessionCtx: other,
      gitMirrorManager: manager,
      agentName: null,
    });
    expect(calls.at(-1)?.activelyInUse).toBe(true);

    releaseSourceReposForSession(live);
    releaseSourceReposForSession(other);
  });
});
