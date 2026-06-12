import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeConfig } from "@first-tree/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Phase-E专项 e2e for the 2026-05-22 agent cwd redesign.
 *
 * Drives real `createClaudeCodeHandler.start()` / `.resume()` against a real
 * temp filesystem + fixture bare repo. The Claude SDK is the ONLY mock — we
 * capture the `query()` options so we can assert the system-prompt block the
 * handler actually sends.
 *
 * Under the agent-managed-repos refactor the runtime never materialises
 * source repos on disk — declared `gitRepos` only surface in the briefing
 * (E1/E5, which covered the clone/update machinery, were removed with it).
 *
 * Surviving invariants:
 *
 *   E2  `worktrees/` subdir is NOT pre-created by `start()` — reserved
 *       for the agent's on-demand worktrees.
 *   E3  Second chat on same agent skips bootstrap (sentinel guard); the
 *       runtime never clones declared repos onto disk.
 *   E4  Briefing contains "Source Repositories (agent-managed)" +
 *       "Worktrees (one per task — you create AND clean up)"; does NOT
 *       contain legacy "Predeclared worktrees".
 *   E6  `.first-tree-workspace/identity.json` carries agent-level stable fields only —
 *       no `chatId` / `chatContext`.
 *   E7  Legacy `<chatId>/` directories that pre-date the redesign are
 *       left untouched when a fresh session starts.
 */

const capturedSdkOptions: Array<{ options?: Record<string, unknown> }> = [];

vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  const fakeQuery = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => ({ done: true, value: undefined }),
      };
    },
    close: () => {},
    setModel: async () => {},
  };
  return {
    query: (args: { options?: Record<string, unknown> }) => {
      capturedSdkOptions.push({ options: args?.options });
      return fakeQuery;
    },
  };
});

import { createClaudeCodeHandler } from "../handlers/claude-code.js";
import { createAgentConfigCache } from "../runtime/agent-config-cache.js";
import { IDENTITY_JSON_REL } from "../runtime/bootstrap.js";
import type { SessionContext } from "../runtime/handler.js";
import { INIT_COMPLETE_SENTINEL_REL } from "../runtime/workspace.js";
import { mockCtxPlumbing } from "./test-helpers.js";

const AGENT_ID = "019d9a97-90b0-716b-8317-a8c0be8430d7";

let workRoot: string;
let fixtureBareRepo: string;

beforeAll(() => {
  workRoot = mkdtempSync(join(tmpdir(), "ftt-cwd-redesign-"));
  const seed = join(workRoot, "seed");
  mkdirSync(seed, { recursive: true });
  execSync("git init -q -b main", { cwd: seed });
  execSync("git config user.email t@test.com && git config user.name test", { cwd: seed, shell: "/bin/bash" });
  writeFileSync(join(seed, "README.md"), "# fixture repo");
  execSync("git add . && git commit -q -m seed", { cwd: seed, shell: "/bin/bash" });

  fixtureBareRepo = join(workRoot, "fixture-bare.git");
  execSync(`git clone -q --bare ${seed} ${fixtureBareRepo}`);
});

afterAll(() => {
  if (existsSync(workRoot)) rmSync(workRoot, { recursive: true, force: true });
});

function buildCache(gitRepos: AgentRuntimeConfig["payload"]["gitRepos"]) {
  const stubSdk = {
    fetchAgentConfig: async () =>
      ({
        agentId: AGENT_ID,
        version: 1,
        payload: {
          prompt: { append: "" },
          model: "",
          mcpServers: [],
          env: [],
          gitRepos,
        },
        updatedAt: new Date().toISOString(),
        updatedBy: "test",
      }) as unknown as AgentRuntimeConfig,
  } as unknown as Parameters<typeof createAgentConfigCache>[0]["sdk"];
  return createAgentConfigCache({ sdk: stubSdk });
}

function buildSessionCtx(chatId: string): SessionContext {
  const sendMessage = async () => undefined;
  return {
    agent: {
      agentId: AGENT_ID,
      inboxId: "inbox-test",
      displayName: "test",
      type: "agent",
      visibility: "organization",
      delegateMention: null,
      metadata: {},
    },
    sdk: { serverUrl: "http://test", sendMessage } as unknown as SessionContext["sdk"],
    chatId,
    log: () => {},
    recordProviderActivity: () => {},
    emitEvent: () => {},
    ...mockCtxPlumbing({ sendMessage }, chatId),
  };
}

function makeMessage(chatId: string, id: string) {
  return {
    id,
    chatId,
    senderId: "user",
    format: "text" as const,
    content: "hello",
    metadata: null,
  };
}

describe("Phase E · agent cwd redesign — end-to-end invariants", () => {
  it("E2: worktrees/ subdir is NOT pre-created by start()", async () => {
    capturedSdkOptions.length = 0;
    const dataDir = mkdtempSync(join(tmpdir(), "ftt-e2-"));
    const workspaceRoot = join(dataDir, "workspaces", "agent-1");

    const cache = buildCache([{ url: fixtureBareRepo, localPath: "repos/first-tree" }]);
    await cache.refresh(AGENT_ID);

    const handler = createClaudeCodeHandler({ workspaceRoot, agentConfigCache: cache });
    await handler.start(makeMessage("chat-e2", "msg-1"), buildSessionCtx("chat-e2"));

    // `worktrees/` subdir is reserved for agent's on-demand worktrees only;
    // runtime must never pre-create it. Use both negation forms (the subdir
    // itself + the old-design-style path) to lock down regression risk.
    expect(existsSync(join(workspaceRoot, "worktrees"))).toBe(false);
    expect(existsSync(join(workspaceRoot, "worktrees", "repos", "first-tree"))).toBe(false);

    await handler.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("E3: second chat on same agent skips bootstrap (sentinel guard); declared repos are never cloned by the runtime", async () => {
    capturedSdkOptions.length = 0;
    const dataDir = mkdtempSync(join(tmpdir(), "ftt-e3-"));
    const workspaceRoot = join(dataDir, "workspaces", "agent-1");

    const cache = buildCache([{ url: fixtureBareRepo, localPath: "repo-a" }]);
    await cache.refresh(AGENT_ID);

    // First chat — full bootstrap path.
    const h1 = createClaudeCodeHandler({ workspaceRoot, agentConfigCache: cache });
    await h1.start(makeMessage("chat-A", "msg-A1"), buildSessionCtx("chat-A"));

    const sourceRepoPath = join(workspaceRoot, "repo-a");
    const sentinelPath = join(workspaceRoot, INIT_COMPLETE_SENTINEL_REL);
    expect(existsSync(sentinelPath)).toBe(true);
    // Agent-managed repos: the runtime declares the repo in the briefing but
    // performs NO git materialisation — nothing lands on disk.
    expect(existsSync(sourceRepoPath)).toBe(false);

    // Drop a marker in the agent home — the second chat's start must reuse
    // the bootstrapped home (sentinel guard), not wipe and rebuild it.
    const reuseMarker = join(workspaceRoot, ".reuse-marker");
    writeFileSync(reuseMarker, "chat-A");
    await h1.shutdown();

    // Second chat — different chatId, same workspaceRoot.
    const h2 = createClaudeCodeHandler({ workspaceRoot, agentConfigCache: cache });
    await h2.start(makeMessage("chat-B", "msg-B1"), buildSessionCtx("chat-B"));

    // The marker must survive, the repo must still not be materialised.
    expect(existsSync(reuseMarker)).toBe(true);
    expect(readFileSync(reuseMarker, "utf-8")).toBe("chat-A");
    expect(existsSync(sourceRepoPath)).toBe(false);
    // Sentinel re-written is fine (idempotent) — the body's `completedAt`
    // refreshes — but the file must still exist.
    expect(existsSync(sentinelPath)).toBe(true);

    await h2.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("E4: unified briefing contains new redesign sections in AGENTS.md (CLAUDE.md symlinks to it); no legacy 'Predeclared worktrees' wording", async () => {
    capturedSdkOptions.length = 0;
    const dataDir = mkdtempSync(join(tmpdir(), "ftt-e4-"));
    const workspaceRoot = join(dataDir, "workspaces", "agent-1");

    const cache = buildCache([{ url: fixtureBareRepo, localPath: "lib" }]);
    await cache.refresh(AGENT_ID);

    const handler = createClaudeCodeHandler({ workspaceRoot, agentConfigCache: cache });
    await handler.start(makeMessage("chat-e4", "msg-e4"), buildSessionCtx("chat-e4"));

    // Per the unified-briefing redesign the SDK no longer carries a
    // `systemPrompt.append` — agent identity / working-dir convention /
    // source repos / chat context all flow through AGENTS.md (with
    // CLAUDE.md symlinked to it). Assert against the on-disk briefing.
    const agentsMdPath = join(workspaceRoot, "AGENTS.md");
    const claudeMdPath = join(workspaceRoot, "CLAUDE.md");
    expect(existsSync(agentsMdPath)).toBe(true);
    expect(existsSync(claudeMdPath)).toBe(true);
    const briefing = readFileSync(agentsMdPath, "utf-8");

    // New redesign sections — must be present.
    // (Section headers were tightened in the AGENTS.md restructure follow-up:
    // `# Working Directory Convention` → `## Working Directory` under the
    // new `# Working in First Tree` umbrella, etc.)
    expect(briefing).toContain("# Working in First Tree");
    expect(briefing).toContain("## Working Directory");
    expect(briefing).toContain("## Source Repositories (agent-managed)");
    expect(briefing).toContain("## Worktrees (one per task — you create AND clean up)");
    expect(briefing).toContain("git worktree add");
    expect(briefing).toContain("No worktrees are pre-created");

    // Top-level path of the declared repo surfaces in the briefing even
    // though the runtime never materialises it on disk.
    expect(briefing).toContain(join(workspaceRoot, "lib"));
    expect(existsSync(join(workspaceRoot, "lib"))).toBe(false);

    // Legacy wording from the previous design MUST be gone.
    expect(briefing).not.toContain("Predeclared worktrees");
    // The pre-restructure section names must NOT linger — they would
    // double-render with the new headers if a regenerator path skipped a step.
    expect(briefing).not.toContain("# Working Directory Convention");
    expect(briefing).not.toContain("## Creating Worktrees On Demand");
    expect(briefing).not.toContain("# First Tree Agent Runtime");
    // Negation: the repo path should NOT be presented under worktrees/.
    expect(briefing).not.toContain(`${workspaceRoot}/worktrees/lib`);

    // CLAUDE.md symlinks to AGENTS.md — reading it yields the same payload.
    expect(readFileSync(claudeMdPath, "utf-8")).toBe(briefing);

    await handler.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("E6: identity.json carries agent-level stable fields only (no chatId / chatContext)", async () => {
    capturedSdkOptions.length = 0;
    const dataDir = mkdtempSync(join(tmpdir(), "ftt-e6-"));
    const workspaceRoot = join(dataDir, "workspaces", "agent-1");

    const cache = buildCache([]);
    await cache.refresh(AGENT_ID);

    const handler = createClaudeCodeHandler({ workspaceRoot, agentConfigCache: cache });
    await handler.start(makeMessage("chat-e6", "msg-e6"), buildSessionCtx("chat-e6"));

    const identityPath = join(workspaceRoot, IDENTITY_JSON_REL);
    expect(existsSync(identityPath)).toBe(true);
    const identity = JSON.parse(readFileSync(identityPath, "utf-8"));

    expect(identity.agentId).toBe(AGENT_ID);
    expect(identity.serverUrl).toBe("http://test");
    expect(identity.displayName).toBe("test");

    // Per the redesign — chat-scoped fields MUST be absent from disk.
    expect("chatId" in identity).toBe(false);
    expect("chatContext" in identity).toBe(false);

    await handler.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("E7: legacy <chatId>/ directories pre-dating the redesign survive a fresh session start", async () => {
    capturedSdkOptions.length = 0;
    const dataDir = mkdtempSync(join(tmpdir(), "ftt-e7-"));
    const workspaceRoot = join(dataDir, "workspaces", "agent-1");

    // Simulate a v1.x-era residual directory inside the agent home.
    const legacyChatDir = join(workspaceRoot, "legacy-chat-id-019d");
    mkdirSync(join(legacyChatDir, ".agent"), { recursive: true });
    writeFileSync(join(legacyChatDir, "CLAUDE.md"), "legacy content", "utf-8");
    writeFileSync(join(legacyChatDir, ".agent", "identity.json"), "{}", "utf-8");

    const cache = buildCache([]);
    await cache.refresh(AGENT_ID);

    const handler = createClaudeCodeHandler({ workspaceRoot, agentConfigCache: cache });
    await handler.start(makeMessage("chat-e7", "msg-e7"), buildSessionCtx("chat-e7"));

    // Fresh session creates agent home + new layout.
    expect(existsSync(join(workspaceRoot, IDENTITY_JSON_REL))).toBe(true);

    // Legacy dir survives byte-identical — that's the migration story.
    expect(existsSync(legacyChatDir)).toBe(true);
    expect(readFileSync(join(legacyChatDir, "CLAUDE.md"), "utf-8")).toBe("legacy content");
    expect(readFileSync(join(legacyChatDir, ".agent", "identity.json"), "utf-8")).toBe("{}");

    await handler.shutdown();
    // Legacy must STILL survive after shutdown (no rm of cwd or sibling).
    expect(existsSync(legacyChatDir)).toBe(true);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("E8: resume of a stale pre-upgrade sessionId falls back to fresh start (R2 fallback)", async () => {
    // Defensive fallback path: when sessionId can't be located at EITHER
    // cwd (legacy chatId dir or agent home), the handler mints a fresh
    // id and starts cold — First Tree-side chat history is preserved.
    // SessionManager then persists the returned id, so subsequent inbox
    // messages resume against the new id cleanly (no permanent error loop).
    capturedSdkOptions.length = 0;
    const dataDir = mkdtempSync(join(tmpdir(), "ftt-e8-"));
    const workspaceRoot = join(dataDir, "workspaces", "agent-1");

    const cache = buildCache([]);
    await cache.refresh(AGENT_ID);

    const handler = createClaudeCodeHandler({ workspaceRoot, agentConfigCache: cache });
    // No transcript exists anywhere under `~/.claude/projects/<encoded-cwd>/`.
    const staleSessionId = "72a19485-ca9e-4bc3-9add-a57e8314e5c3";
    const returnedSessionId = await handler.resume(
      makeMessage("chat-e8", "msg-e8"),
      staleSessionId,
      buildSessionCtx("chat-e8"),
    );

    // Returned sessionId MUST differ from the stale input — that's how
    // SessionManager learns to update its registry.
    expect(returnedSessionId).not.toBe(staleSessionId);
    expect(returnedSessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

    // The SDK was invoked WITHOUT a resume argument (fresh start semantics).
    expect(capturedSdkOptions.length).toBeGreaterThan(0);
    const lastOptions = capturedSdkOptions[capturedSdkOptions.length - 1]?.options;
    expect(lastOptions?.resume).toBeUndefined();
    expect(lastOptions?.sessionId).toBe(returnedSessionId);

    await handler.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("E9: resume of a pre-redesign session routes to the legacy chat-dir cwd (R2 primary path)", async () => {
    // Primary R2 path: a session created BEFORE the cwd reversal has its
    // Claude SDK transcript keyed off the OLD per-chat cwd encoding.
    // `resume()` must detect this and run the SDK against the legacy cwd
    // verbatim, preserving the agent's SDK turn history across upgrade.
    capturedSdkOptions.length = 0;
    const dataDir = mkdtempSync(join(tmpdir(), "ftt-e9-"));
    const workspaceRoot = join(dataDir, "workspaces", "agent-1");
    const chatId = "chat-e9";

    // Simulate the v1.x layout that pre-existed on disk before the upgrade.
    const legacyCwd = join(workspaceRoot, chatId);
    mkdirSync(join(legacyCwd, ".agent"), { recursive: true });
    writeFileSync(join(legacyCwd, "CLAUDE.md"), "legacy session prompt\n");
    writeFileSync(join(legacyCwd, ".agent", "identity.json"), '{"agentId":"legacy"}');

    // Materialise the SDK transcript at the legacy-cwd-encoded path under
    // `~/.claude/projects/`. The probe (`claudeSessionFileExists`) follows
    // the same encoding rule the SDK uses: replace every non-alphanumeric
    // char in the absolute cwd with "-".
    const legacySessionId = "abcd1234-5678-90ab-cdef-1234567890ab";
    const legacyEncoded = legacyCwd.replace(/[^a-zA-Z0-9-]/g, "-");
    const legacyTranscriptDir = join(homedir(), ".claude", "projects", legacyEncoded);
    mkdirSync(legacyTranscriptDir, { recursive: true });
    const legacyTranscriptPath = join(legacyTranscriptDir, `${legacySessionId}.jsonl`);
    writeFileSync(legacyTranscriptPath, '{"type":"system","subtype":"init"}\n');

    try {
      const cache = buildCache([]);
      await cache.refresh(AGENT_ID);

      const handler = createClaudeCodeHandler({ workspaceRoot, agentConfigCache: cache });
      const returnedSessionId = await handler.resume(
        makeMessage(chatId, "msg-e9"),
        legacySessionId,
        buildSessionCtx(chatId),
      );

      // The legacy sessionId MUST be preserved — no fresh-id rotation here.
      expect(returnedSessionId).toBe(legacySessionId);

      // SDK was invoked with the legacy sessionId on the `resume` channel.
      expect(capturedSdkOptions.length).toBeGreaterThan(0);
      const lastOptions = capturedSdkOptions[capturedSdkOptions.length - 1]?.options;
      expect(lastOptions?.resume).toBe(legacySessionId);
      // cwd points at the legacy chat dir, NOT at the agent home root.
      expect(lastOptions?.cwd).toBe(legacyCwd);

      // The legacy `.agent/` layout is left alone — we still skip
      // `ensureAgentBootstrap` so v1.x identity.json and source-repo
      // checkouts at `<localPath>/` survive intact.
      expect(readFileSync(join(legacyCwd, ".agent", "identity.json"), "utf-8")).toBe('{"agentId":"legacy"}');

      // CLAUDE.md / AGENTS.md are refreshed though — without the SDK
      // `systemPrompt.append` channel the unified briefing MUST be
      // materialised in the legacy cwd, otherwise the resumed session
      // would only see the v1.x stable CLAUDE.md and lose
      // `payload.prompt.append` / Current Chat Context. The briefing now
      // lands as AGENTS.md, and CLAUDE.md becomes a relative symlink to it.
      const refreshedClaudeMd = readFileSync(join(legacyCwd, "CLAUDE.md"), "utf-8");
      expect(refreshedClaudeMd).not.toBe("legacy session prompt\n");
      expect(refreshedClaudeMd).toContain("# Identity");
      expect(refreshedClaudeMd).toContain("# Working in First Tree");
      expect(refreshedClaudeMd).toContain("## Working Directory");
      expect(readFileSync(join(legacyCwd, "AGENTS.md"), "utf-8")).toBe(refreshedClaudeMd);

      await handler.shutdown();
    } finally {
      // Always clean up the fake SDK transcript so this test stays hermetic.
      rmSync(legacyTranscriptDir, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
