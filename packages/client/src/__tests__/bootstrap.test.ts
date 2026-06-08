import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  BUNDLED_CLI_VERSION_REL,
  bootstrapWorkspace,
  CONTEXT_TREE_HEAD_REL,
  FIRST_TREE_RUNTIME_DIR,
  IDENTITY_JSON_REL,
  type ContextTreeBinding,
  deepEqualIdentity,
  installCoreSkills,
  installFirstTreeIntegration,
  readCachedBundledCliVersion,
  readCachedContextTreeHead,
  readContextTreeHead,
  resolveBundledCliVersion,
  withContextTreeSyncLock,
  writeBundledCliVersion,
  writeContextTreeHead,
} from "../runtime/bootstrap.js";
import { setCliBinding } from "../runtime/cli-binding.js";
import type { AgentIdentity } from "../runtime/handler.js";

// Pin the CLI binding to the prod identity so assertions against any
// emitted CLI sub-process names keep matching the literals they have
// always matched. Production-channel tests stay untouched; non-prod
// channels are exercised in dedicated test cases below.
beforeAll(() => {
  setCliBinding({ binName: "first-tree", packageName: "first-tree" });
});

// Use a real temp directory for file-based tests
const tmpBase = join(import.meta.dirname ?? __dirname, "../../.test-tmp-bootstrap");

function cleanTmp(): void {
  try {
    rmSync(tmpBase, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

afterEach(() => {
  cleanTmp();
  vi.restoreAllMocks();
  // Reset the binding to prod after every test so a case that switches
  // channels (staging / dev) does not leak into the next case. The
  // file-level `beforeAll` already set this; we mirror it here.
  setCliBinding({ binName: "first-tree", packageName: "first-tree" });
});

function makeIdentity(overrides?: Partial<AgentIdentity>): AgentIdentity {
  return {
    agentId: "test-agent",
    inboxId: "inbox-test-agent",
    displayName: "Test Agent",
    type: "agent",
    visibility: "organization",
    delegateMention: null,
    metadata: {},
    ...overrides,
  };
}

describe("contextTreeCloneDir", () => {
  it("isolates local checkouts by repo URL and branch", async () => {
    const { contextTreeCloneDir } = await import("../runtime/bootstrap.js");
    const main = contextTreeCloneDir("https://github.com/example/context-tree", "main");
    const release = contextTreeCloneDir("https://github.com/example/context-tree", "release");
    const otherOrg = contextTreeCloneDir("https://github.com/other/context-tree", "main");

    expect(main).not.toBe(release);
    expect(main).not.toBe(otherOrg);
    expect(main).toContain("context-tree-repos");
    expect(main.split("/").at(-1)).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("withContextTreeSyncLock", () => {
  it("dedups concurrent callers sharing the same key to a single fn invocation", async () => {
    // Each clone dir corresponds to one (repo, branch) pair. When N agents
    // share that pair (the common case — one Context Tree per org), all N
    // must share one in-flight sync instead of queuing N sequential pulls.
    let invocations = 0;
    let resolveSync: ((value: ContextTreeBinding) => void) | undefined;
    const fn = (): Promise<ContextTreeBinding | null> => {
      invocations++;
      return new Promise<ContextTreeBinding>((resolve) => {
        resolveSync = resolve;
      });
    };

    const key = "/tmp/clone-dir-A";
    const p1 = withContextTreeSyncLock(key, fn);
    const p2 = withContextTreeSyncLock(key, fn);
    const p3 = withContextTreeSyncLock(key, fn);

    expect(invocations).toBe(1);
    expect(p1).toBe(p2);
    expect(p2).toBe(p3);

    const binding: ContextTreeBinding = { path: key, repoUrl: "git@example/x", branch: "main" };
    resolveSync?.(binding);
    await expect(p1).resolves.toBe(binding);
    await expect(p2).resolves.toBe(binding);
    await expect(p3).resolves.toBe(binding);
  });

  it("isolates locks across distinct keys (different repos sync in parallel)", async () => {
    let invocations = 0;
    const fn = (): Promise<ContextTreeBinding | null> => {
      invocations++;
      return Promise.resolve(null);
    };

    await Promise.all([withContextTreeSyncLock("/tmp/clone-A", fn), withContextTreeSyncLock("/tmp/clone-B", fn)]);

    expect(invocations).toBe(2);
  });

  it("clears the slot after settle so a later call triggers a fresh sync", async () => {
    let invocations = 0;
    const fn = (): Promise<ContextTreeBinding | null> => {
      invocations++;
      return Promise.resolve(null);
    };

    await withContextTreeSyncLock("/tmp/clone-C", fn);
    await withContextTreeSyncLock("/tmp/clone-C", fn);

    expect(invocations).toBe(2);
  });

  it("propagates rejection to all concurrent callers and clears the slot", async () => {
    let invocations = 0;
    let rejectSync: ((reason: Error) => void) | undefined;
    const fn = (): Promise<ContextTreeBinding | null> => {
      invocations++;
      if (invocations === 1) {
        return new Promise<ContextTreeBinding>((_, reject) => {
          rejectSync = reject;
        });
      }
      // Later retries succeed immediately so the test can observe that the
      // slot was cleared without hanging on a second pending promise.
      return Promise.resolve(null);
    };

    const key = "/tmp/clone-D";
    const p1 = withContextTreeSyncLock(key, fn);
    const p2 = withContextTreeSyncLock(key, fn);

    expect(invocations).toBe(1);
    expect(p1).toBe(p2);

    rejectSync?.(new Error("git pull failed"));
    await expect(p1).rejects.toThrow("git pull failed");
    await expect(p2).rejects.toThrow("git pull failed");

    // After the failed sync clears the slot, a new caller is allowed to
    // retry — important so the next agent's bind isn't poisoned by an
    // earlier transient network failure.
    await expect(withContextTreeSyncLock(key, fn)).resolves.toBeNull();
    expect(invocations).toBe(2);
  });
});

describe("bootstrapWorkspace", () => {
  it("writes identity.json with agent-level stable fields only (no chatId / chatContext)", () => {
    const workspace = join(tmpBase, "ws-identity");
    mkdirSync(workspace, { recursive: true });

    bootstrapWorkspace({
      workspacePath: workspace,
      identity: makeIdentity({ agentId: "my-agent", type: "agent", delegateMention: "owner" }),
      contextTreePath: null,
      serverUrl: "http://localhost:8000",
    });

    const identityPath = join(workspace, IDENTITY_JSON_REL);
    expect(existsSync(identityPath)).toBe(true);

    const data = JSON.parse(readFileSync(identityPath, "utf-8"));
    expect(data.agentId).toBe("my-agent");
    expect(data.type).toBe("agent");
    expect(data.delegateMention).toBe("owner");
    expect(data.serverUrl).toBe("http://localhost:8000");
    // Per agent-session-cwd-redesign: identity.json holds agent-level state
    // only. chatId / chatContext now live in the per-turn system prompt.
    expect("chatId" in data).toBe(false);
    expect("chatContext" in data).toBe(false);
  });

  it("no longer writes the legacy `.agent/tools.md` (content now lives in AGENTS.md)", () => {
    // Pre-PR-797 the runtime emitted a `.agent/tools.md` stable file that the
    // SDK CLAUDE.md generator referenced. PR 797 collapsed CLAUDE.md and the
    // tools doc into the unified AGENTS.md briefing; this PR completes that
    // by dropping the on-disk `.agent/tools.md` write entirely. The runtime
    // invariants (final-text contract, silent-turn, Issue #389, Decision
    // guide, etc.) are covered by the `buildAgentBriefing` tests.
    const workspace = join(tmpBase, "ws-no-tools-md");
    mkdirSync(workspace, { recursive: true });

    bootstrapWorkspace({
      workspacePath: workspace,
      identity: makeIdentity(),
      contextTreePath: null,
      serverUrl: "http://localhost:8000",
    });

    expect(existsSync(join(workspace, FIRST_TREE_RUNTIME_DIR, "tools.md"))).toBe(false);
  });

  it("migrates a legacy .agent/ runtime dir into .first-tree-workspace/", () => {
    const workspace = join(tmpBase, "ws-migrate-legacy-agent");
    mkdirSync(join(workspace, ".agent"), { recursive: true });
    writeFileSync(join(workspace, ".agent", "identity.json"), '{"agentId":"legacy-agent"}');
    writeFileSync(join(workspace, ".first-tree-workspace"), "", "utf-8");

    bootstrapWorkspace({
      workspacePath: workspace,
      identity: makeIdentity({ agentId: "new-agent" }),
      contextTreePath: null,
      serverUrl: "http://localhost:8000",
    });

    expect(existsSync(join(workspace, ".agent"))).toBe(false);
    expect(existsSync(join(workspace, FIRST_TREE_RUNTIME_DIR))).toBe(true);
    expect(existsSync(join(workspace, IDENTITY_JSON_REL))).toBe(true);
    expect(lstatSync(join(workspace, FIRST_TREE_RUNTIME_DIR)).isDirectory()).toBe(true);
    const data = JSON.parse(readFileSync(join(workspace, IDENTITY_JSON_REL), "utf-8"));
    expect(data.agentId).toBe("new-agent");
  });

  it("prunes a migrated legacy tools.md during bootstrap", () => {
    const workspace = join(tmpBase, "ws-prune-legacy-tools");
    mkdirSync(join(workspace, ".agent"), { recursive: true });
    writeFileSync(join(workspace, ".agent", "tools.md"), "legacy tools");

    bootstrapWorkspace({
      workspacePath: workspace,
      identity: makeIdentity(),
      contextTreePath: null,
      serverUrl: "http://localhost:8000",
    });

    expect(existsSync(join(workspace, FIRST_TREE_RUNTIME_DIR, "tools.md"))).toBe(false);
  });

  it("keeps current runtime entries when legacy paths collide during migration", () => {
    const workspace = join(tmpBase, "ws-legacy-collision");
    mkdirSync(join(workspace, FIRST_TREE_RUNTIME_DIR, "dir-wins"), { recursive: true });
    writeFileSync(join(workspace, FIRST_TREE_RUNTIME_DIR, "dir-wins", "keep.txt"), "target-dir");
    writeFileSync(join(workspace, FIRST_TREE_RUNTIME_DIR, "file-wins"), "target-file");
    mkdirSync(join(workspace, ".agent", "file-wins"), { recursive: true });
    writeFileSync(join(workspace, ".agent", "file-wins", "legacy.txt"), "legacy-dir");
    writeFileSync(join(workspace, ".agent", "dir-wins"), "legacy-file");

    bootstrapWorkspace({
      workspacePath: workspace,
      identity: makeIdentity(),
      contextTreePath: null,
      serverUrl: "http://localhost:8000",
    });

    expect(lstatSync(join(workspace, FIRST_TREE_RUNTIME_DIR, "dir-wins")).isDirectory()).toBe(true);
    expect(readFileSync(join(workspace, FIRST_TREE_RUNTIME_DIR, "dir-wins", "keep.txt"), "utf-8")).toBe(
      "target-dir",
    );
    expect(lstatSync(join(workspace, FIRST_TREE_RUNTIME_DIR, "file-wins")).isFile()).toBe(true);
    expect(readFileSync(join(workspace, FIRST_TREE_RUNTIME_DIR, "file-wins"), "utf-8")).toBe("target-file");
    expect(existsSync(join(workspace, ".agent"))).toBe(false);
  });

  it("replaces a dangling .first-tree-workspace symlink with the runtime directory", () => {
    const workspace = join(tmpBase, "ws-dangling-runtime-marker");
    mkdirSync(workspace, { recursive: true });
    symlinkSync(join(workspace, "missing-marker-target"), join(workspace, FIRST_TREE_RUNTIME_DIR));

    bootstrapWorkspace({
      workspacePath: workspace,
      identity: makeIdentity(),
      contextTreePath: null,
      serverUrl: "http://localhost:8000",
    });

    expect(lstatSync(join(workspace, FIRST_TREE_RUNTIME_DIR)).isDirectory()).toBe(true);
    expect(existsSync(join(workspace, IDENTITY_JSON_REL))).toBe(true);
  });

  it("prunes a legacy `.agent/context/` staging directory on re-bootstrap", () => {
    // Pre-PR-797 the runtime staged `agent-instructions.md` and
    // `domain-map.md` under `.agent/context/`. Those staged copies were
    // unused after the briefing started reading the tree directly, and are
    // now redundant since the unified briefing references the tree by path
    // instead of inlining content. A pre-existing `.agent/context/` from a
    // resumed agent home must therefore be pruned at bootstrap time.
    const workspace = join(tmpBase, "ws-prune-legacy-ctx");
    mkdirSync(join(workspace, ".agent", "context"), { recursive: true });
    writeFileSync(join(workspace, ".agent", "context", "agent-instructions.md"), "legacy");
    writeFileSync(join(workspace, ".agent", "context", "domain-map.md"), "legacy");

    bootstrapWorkspace({
      workspacePath: workspace,
      identity: makeIdentity(),
      contextTreePath: null,
      serverUrl: "http://localhost:8000",
    });

    expect(existsSync(join(workspace, FIRST_TREE_RUNTIME_DIR, "context"))).toBe(false);
  });

  it("does not write self.md (per PRD D7 — prompt lives in agent_configs)", () => {
    const workspace = join(tmpBase, "ws-no-self-md");
    mkdirSync(workspace, { recursive: true });

    bootstrapWorkspace({
      workspacePath: workspace,
      identity: makeIdentity({ agentId: "my-agent" }),
      contextTreePath: null,
      serverUrl: "http://localhost:8000",
    });

    const selfPath = join(workspace, FIRST_TREE_RUNTIME_DIR, "context", "self.md");
    expect(existsSync(selfPath)).toBe(false);
  });

  it("skips context when contextTreePath is null", () => {
    const workspace = join(tmpBase, "ws-no-ctx");
    mkdirSync(workspace, { recursive: true });

    bootstrapWorkspace({
      workspacePath: workspace,
      identity: makeIdentity(),
      contextTreePath: null,
      serverUrl: "http://localhost:8000",
    });

    const selfPath = join(workspace, FIRST_TREE_RUNTIME_DIR, "context", "self.md");
    expect(existsSync(selfPath)).toBe(false);
  });

  it("skips context when agent not found in context tree", () => {
    const workspace = join(tmpBase, "ws-missing-agent");
    const ctxTree = join(tmpBase, "context-tree-empty");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(join(ctxTree, "members"), { recursive: true });

    bootstrapWorkspace({
      workspacePath: workspace,
      identity: makeIdentity({ agentId: "nonexistent" }),
      contextTreePath: ctxTree,
      serverUrl: "http://localhost:8000",
    });

    const selfPath = join(workspace, FIRST_TREE_RUNTIME_DIR, "context", "self.md");
    expect(existsSync(selfPath)).toBe(false);
    // identity.json should still exist
    expect(existsSync(join(workspace, IDENTITY_JSON_REL))).toBe(true);
  });

  it("no longer stages AGENT.md / NODE.md under `.agent/context/` (briefing references the tree path instead)", () => {
    // The unified briefing's `## Tree Location` section points the agent at
    // the bound tree checkout directly; the legacy staging copies under
    // `.agent/context/agent-instructions.md` and `.agent/context/domain-map.md`
    // are no longer read by anything and so are no longer written.
    const workspace = join(tmpBase, "ws-no-tree-staging");
    const ctxTree = join(tmpBase, "ctx-tree-no-staging");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(join(ctxTree, "members", "test-agent"), { recursive: true });
    writeFileSync(join(ctxTree, "AGENT.md"), "## Before Every Task\n\nRead the root NODE.md.");
    writeFileSync(join(ctxTree, "NODE.md"), "# Context Tree\n\n## Domains\n\n- kael/\n");

    bootstrapWorkspace({
      workspacePath: workspace,
      identity: makeIdentity(),
      contextTreePath: ctxTree,
      serverUrl: "http://localhost:8000",
    });

    expect(existsSync(join(workspace, FIRST_TREE_RUNTIME_DIR, "context", "agent-instructions.md"))).toBe(false);
    expect(existsSync(join(workspace, FIRST_TREE_RUNTIME_DIR, "context", "domain-map.md"))).toBe(false);
    expect(existsSync(join(workspace, FIRST_TREE_RUNTIME_DIR, "context"))).toBe(false);
  });

  it("does not write degraded.md when contextTreePath is null (no Context Tree is normal)", () => {
    const workspace = join(tmpBase, "ws-no-tree");
    mkdirSync(workspace, { recursive: true });

    bootstrapWorkspace({
      workspacePath: workspace,
      identity: makeIdentity(),
      contextTreePath: null,
      serverUrl: "http://localhost:8000",
    });

    const degradedPath = join(workspace, FIRST_TREE_RUNTIME_DIR, "context", "degraded.md");
    expect(existsSync(degradedPath)).toBe(false);
  });

  // Per-chat fields (chatId, participants, topic) intentionally have no
  // on-disk home — they flow through the unified briefing's per-turn
  // `## Current Chat Context` block, exercised by the buildAgentBriefing
  // tests. Issue #808 tracks moving that block off the per-agent file
  // entirely.

  it("overwrites existing files on re-bootstrap", () => {
    const workspace = join(tmpBase, "ws-overwrite");
    mkdirSync(join(workspace, ".agent"), { recursive: true });
    writeFileSync(join(workspace, ".agent", "identity.json"), '{"agentId":"old"}');

    bootstrapWorkspace({
      workspacePath: workspace,
      identity: makeIdentity({ agentId: "new-agent" }),
      contextTreePath: null,
      serverUrl: "http://localhost:8000",
    });

    const data = JSON.parse(readFileSync(join(workspace, IDENTITY_JSON_REL), "utf-8"));
    expect(data.agentId).toBe("new-agent");
  });
});

/**
 * Build a fixture `skills/` root under `tmpBase` whose layout matches the
 * shape `bundledSkillsRoot` expects: `<root>/<name>/SKILL.md` + optional
 * `VERSION`. The marker file `first-tree/SKILL.md` is mandatory because
 * `resolveBundledSkillsRoot()` (and the override path) both probe for it
 * to disambiguate the bundled-skills dir from random siblings — without
 * it the installer treats the root as unfindable.
 */
function makeFixtureSkillsRoot(
  name: string,
  skills: Array<{ name: string; version?: string; extraFile?: { rel: string; content: string } }>,
): string {
  const root = join(tmpBase, `bundled-skills-${name}`);
  mkdirSync(root, { recursive: true });
  // first-tree/SKILL.md is the probe marker resolveBundledSkillsRoot()
  // walks up looking for — include it even if "first-tree" is not in the
  // requested skill list, so the override resolves.
  if (!skills.some((s) => s.name === "first-tree")) {
    mkdirSync(join(root, "first-tree"), { recursive: true });
    writeFileSync(join(root, "first-tree", "SKILL.md"), "---\nname: first-tree\n---\n");
  }
  for (const skill of skills) {
    const dir = join(root, skill.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${skill.name}\n---\nfixture for ${skill.name}\n`);
    if (skill.version !== undefined) {
      writeFileSync(join(dir, "VERSION"), skill.version);
    }
    if (skill.extraFile) {
      const path = join(dir, skill.extraFile.rel);
      mkdirSync(join(dir, ...skill.extraFile.rel.split("/").slice(0, -1)), { recursive: true });
      writeFileSync(path, skill.extraFile.content);
    }
  }
  return root;
}

describe("installFirstTreeIntegration (inline skill installer)", () => {
  const TREE_SKILLS = ["first-tree", "first-tree-context", "first-tree-sync"];

  function expectSkillInstalled(workspace: string, name: string): void {
    const agentsDir = join(workspace, ".agents", "skills", name);
    const claudeLink = join(workspace, ".claude", "skills", name);
    expect(existsSync(join(agentsDir, "SKILL.md")), `${name} SKILL.md should exist`).toBe(true);
    expect(existsSync(claudeLink), `${name} claude symlink should exist`).toBe(true);
    // Reading the link target verifies it's a symlink — fs.readlinkSync throws
    // on non-symlinks, so the assertion captures both 'is symlink' and 'target'.
    const link = readlinkSync(claudeLink);
    expect(link).toBe(`../../${join(".agents", "skills", name)}`);
  }

  it("copies all tree skills from the bundled root + creates relative .claude symlinks", () => {
    const workspace = join(tmpBase, "integrate-happy");
    mkdirSync(workspace, { recursive: true });
    const bundledSkillsRoot = makeFixtureSkillsRoot(
      "happy",
      TREE_SKILLS.map((n) => ({ name: n, version: "1.0.0" })),
    );

    const logs: string[] = [];
    const result = installFirstTreeIntegration({
      workspacePath: workspace,
      bundledSkillsRoot,
      log: (m) => logs.push(m),
    });

    expect(result, logs.join("\n")).toBe(true);
    for (const name of TREE_SKILLS) expectSkillInstalled(workspace, name);
    expect(logs.join("\n")).toContain("installed first-tree");
  });

  it("skips skills whose on-disk VERSION + SKILL.md content both match bundled (fast path)", () => {
    const workspace = join(tmpBase, "integrate-skip");
    mkdirSync(workspace, { recursive: true });
    const bundledSkillsRoot = makeFixtureSkillsRoot(
      "skip",
      TREE_SKILLS.map((n) => ({ name: n, version: "1.0.0" })),
    );

    // First install populates the workspace.
    installFirstTreeIntegration({ workspacePath: workspace, bundledSkillsRoot, log: () => {} });

    // Drop a non-content marker into each installed skill so we can detect
    // whether the second install ran a full rm+cp (which wipes the marker)
    // or took the fast skip path (which preserves it). Using a NON-SKILL.md
    // file is important — touching SKILL.md would itself trigger the
    // content-drift defense and force a reinstall, which is what the
    // separate "content drift" test below covers.
    for (const name of TREE_SKILLS) {
      writeFileSync(join(workspace, ".agents", "skills", name, ".sentinel"), "marker\n");
    }

    const logs: string[] = [];
    const result = installFirstTreeIntegration({
      workspacePath: workspace,
      bundledSkillsRoot,
      log: (m) => logs.push(m),
    });

    expect(result, logs.join("\n")).toBe(true);
    for (const name of TREE_SKILLS) {
      expect(
        existsSync(join(workspace, ".agents", "skills", name, ".sentinel")),
        `${name} should have been skipped`,
      ).toBe(true);
    }
    expect(logs.join("\n")).toContain("up-to-date");
  });

  it("reinstalls only the skills whose VERSION drifted", () => {
    const workspace = join(tmpBase, "integrate-drift");
    mkdirSync(workspace, { recursive: true });
    const bundledV1 = makeFixtureSkillsRoot(
      "drift-v1",
      TREE_SKILLS.map((n) => ({ name: n, version: "1.0.0" })),
    );
    installFirstTreeIntegration({ workspacePath: workspace, bundledSkillsRoot: bundledV1, log: () => {} });

    // Marker file (NOT SKILL.md) detects which skills got re-copied.
    for (const name of TREE_SKILLS) {
      writeFileSync(join(workspace, ".agents", "skills", name, ".sentinel"), "marker\n");
    }

    // New bundled root: bump only first-tree to 2.0.0; the rest stay at 1.0.0.
    const bundledMixed = makeFixtureSkillsRoot("drift-mixed", [
      { name: "first-tree", version: "2.0.0" },
      { name: "first-tree-context", version: "1.0.0" },
      { name: "first-tree-sync", version: "1.0.0" },
    ]);

    const logs: string[] = [];
    const result = installFirstTreeIntegration({
      workspacePath: workspace,
      bundledSkillsRoot: bundledMixed,
      log: (m) => logs.push(m),
    });
    expect(result, logs.join("\n")).toBe(true);

    // first-tree should have been re-copied (marker gone, fixture content back).
    expect(existsSync(join(workspace, ".agents", "skills", "first-tree", ".sentinel"))).toBe(false);

    // Others should have been skipped (marker preserved).
    for (const name of TREE_SKILLS.filter((n) => n !== "first-tree")) {
      expect(
        existsSync(join(workspace, ".agents", "skills", name, ".sentinel")),
        `${name} should have been skipped`,
      ).toBe(true);
    }

    expect(logs.join("\n")).toContain("installed first-tree");
    expect(logs.join("\n")).toContain("up-to-date");
  });

  it("returns false when a bundled skill source is missing", () => {
    const workspace = join(tmpBase, "integrate-missing");
    mkdirSync(workspace, { recursive: true });
    // Bundled root has only first-tree; the other 4 tree skills are missing.
    const bundledSkillsRoot = makeFixtureSkillsRoot("missing", [{ name: "first-tree", version: "1.0.0" }]);

    const logs: string[] = [];
    const result = installFirstTreeIntegration({
      workspacePath: workspace,
      bundledSkillsRoot,
      log: (m) => logs.push(m),
    });

    expect(result).toBe(false);
    // first-tree installs successfully, the others all fail.
    expectSkillInstalled(workspace, "first-tree");
    expect(existsSync(join(workspace, ".agents", "skills", "first-tree-sync"))).toBe(false);
    expect(logs.join("\n")).toContain("failed first-tree-context, first-tree-sync");
    expect(logs.join("\n")).toContain("First-tree skill install failed (first-tree-context)");
  });

  it("repairs a clobbered .claude symlink without re-copying the .agents tree", () => {
    const workspace = join(tmpBase, "integrate-relink");
    mkdirSync(workspace, { recursive: true });
    const bundledSkillsRoot = makeFixtureSkillsRoot(
      "relink",
      TREE_SKILLS.map((n) => ({ name: n, version: "1.0.0" })),
    );

    installFirstTreeIntegration({ workspacePath: workspace, bundledSkillsRoot, log: () => {} });

    // Operator clobbered .claude/skills/first-tree with a regular file.
    // rmSync without `recursive` follows symlink-to-directory on macOS
    // (Node behavior is OS-dependent), so we pass recursive: true to
    // unconditionally remove whatever's there.
    rmSync(join(workspace, ".claude", "skills", "first-tree"), { force: true, recursive: true });
    writeFileSync(join(workspace, ".claude", "skills", "first-tree"), "clobbered");

    // Pin a NON-content file in .agents so we can detect whether the
    // skill dir was re-copied. Touching SKILL.md would conflict with the
    // installer's content-drift defense (which would correctly treat
    // SKILL.md drift as a reinstall trigger).
    writeFileSync(join(workspace, ".agents", "skills", "first-tree", ".sentinel"), "marker\n");

    const result = installFirstTreeIntegration({ workspacePath: workspace, bundledSkillsRoot, log: () => {} });
    expect(result).toBe(true);
    // Symlink was repaired.
    expectSkillInstalled(workspace, "first-tree");
    // .agents was NOT re-copied — sentinel marker preserved.
    expect(existsSync(join(workspace, ".agents", "skills", "first-tree", ".sentinel"))).toBe(true);
  });

  it("treats SKILL.md content drift as a reinstall trigger even when VERSION matches (defense in depth)", () => {
    // Regression for PR #844 review (yuezengwu MINOR finding): the
    // previous fast path skipped reinstall on VERSION match alone, so a
    // developer who edited SKILL.md but forgot to bump VERSION would
    // silently serve stale skills. The content-drift defense catches
    // this by comparing bundled vs installed SKILL.md content even when
    // VERSION agrees.
    const workspace = join(tmpBase, "integrate-content-drift");
    mkdirSync(workspace, { recursive: true });
    const bundledSkillsRoot = makeFixtureSkillsRoot(
      "content-drift",
      TREE_SKILLS.map((n) => ({ name: n, version: "1.0.0" })),
    );

    installFirstTreeIntegration({ workspacePath: workspace, bundledSkillsRoot, log: () => {} });

    // Simulate "developer edited SKILL.md on disk but VERSION never
    // changed" — same VERSION on both sides, but the installed
    // SKILL.md has drifted from what the bundled payload now contains.
    const installedSkillPath = join(workspace, ".agents", "skills", "first-tree", "SKILL.md");
    writeFileSync(installedSkillPath, "STALE_CONTENT\n");

    const logs: string[] = [];
    const result = installFirstTreeIntegration({
      workspacePath: workspace,
      bundledSkillsRoot,
      log: (m) => logs.push(m),
    });
    expect(result, logs.join("\n")).toBe(true);

    // The stale content was overwritten by the bundled fixture content
    // (not the SENTINEL anymore), confirming the installer detected the
    // drift and ran a full reinstall instead of taking the fast path.
    expect(readFileSync(installedSkillPath, "utf-8")).not.toContain("STALE_CONTENT");
    expect(logs.join("\n")).toContain("installed first-tree");
  });

  it("falls through to reinstall when bundled VERSION is missing (cannot prove match)", () => {
    // Edge case yuezengwu flagged: if one side has a VERSION file and the
    // other doesn't, the fast-path equality check can't fire. Installer
    // must treat the missing fingerprint as "unknown" and do a full copy
    // rather than silently skipping.
    const workspace = join(tmpBase, "integrate-missing-version");
    mkdirSync(workspace, { recursive: true });

    // First install: bundled has VERSION.
    const bundledWith = makeFixtureSkillsRoot(
      "missing-version-with",
      TREE_SKILLS.map((n) => ({ name: n, version: "1.0.0" })),
    );
    installFirstTreeIntegration({ workspacePath: workspace, bundledSkillsRoot: bundledWith, log: () => {} });

    // Drop sentinel into installed skill so we can detect re-copy.
    writeFileSync(join(workspace, ".agents", "skills", "first-tree", ".sentinel"), "marker\n");

    // Second install: bundled root has NO VERSION file for any skill.
    const bundledWithout = makeFixtureSkillsRoot(
      "missing-version-without",
      TREE_SKILLS.map((n) => ({ name: n })),
    );

    const logs: string[] = [];
    const result = installFirstTreeIntegration({
      workspacePath: workspace,
      bundledSkillsRoot: bundledWithout,
      log: (m) => logs.push(m),
    });
    expect(result, logs.join("\n")).toBe(true);

    // Sentinel gone — full reinstall ran because the fingerprint match
    // could not be proven.
    expect(existsSync(join(workspace, ".agents", "skills", "first-tree", ".sentinel"))).toBe(false);
    expect(logs.join("\n")).toContain("installed first-tree");
  });
});

describe("installCoreSkills (no-op for current empty core list)", () => {
  it("returns true without writing anything because CORE_SKILL_NAMES is empty", () => {
    const workspace = join(tmpBase, "core-noop");
    mkdirSync(workspace, { recursive: true });
    const bundledSkillsRoot = makeFixtureSkillsRoot("core-noop", []);

    const logs: string[] = [];
    const result = installCoreSkills({
      workspacePath: workspace,
      bundledSkillsRoot,
      log: (m) => logs.push(m),
    });

    expect(result).toBe(true);
    // No .agents/skills/ should have been created.
    expect(existsSync(join(workspace, ".agents"))).toBe(false);
    expect(existsSync(join(workspace, ".claude"))).toBe(false);
    // No log line when nothing was installed/skipped/failed.
    expect(logs).toEqual([]);
  });
});

describe("Context Tree HEAD drift helpers", () => {
  function makeTreeRepo(dir: string, initialFile = "AGENT.md"): string {
    mkdirSync(dir, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@test"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    writeFileSync(join(dir, initialFile), "v1");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: dir });
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf-8" }).trim();
  }

  it("readContextTreeHead returns the commit hash when the path is a git repo", () => {
    const treeDir = join(tmpBase, "tree-head-1");
    const head = makeTreeRepo(treeDir);
    expect(readContextTreeHead(treeDir)).toBe(head);
  });

  it("readContextTreeHead returns null for non-existent or non-git paths", () => {
    expect(readContextTreeHead(null)).toBeNull();
    expect(readContextTreeHead("/nonexistent/path-does-not-exist")).toBeNull();

    const notGit = join(tmpBase, "tree-head-non-git");
    mkdirSync(notGit, { recursive: true });
    writeFileSync(join(notGit, "some-file"), "x");
    expect(readContextTreeHead(notGit)).toBeNull();
  });

  it("readContextTreeHead returns null when git rev-parse fails", () => {
    const brokenGit = join(tmpBase, "tree-head-broken-git");
    mkdirSync(brokenGit, { recursive: true });
    writeFileSync(join(brokenGit, ".git"), "gitdir: /path/that/does/not/exist\n");

    expect(readContextTreeHead(brokenGit)).toBeNull();
  });

  it("write/read roundtrip pins the HEAD value for drift comparison", () => {
    const workspace = join(tmpBase, "tree-head-cache");
    mkdirSync(workspace, { recursive: true });

    expect(readCachedContextTreeHead(workspace)).toBeNull();

    writeContextTreeHead(workspace, "abc123def456");
    expect(readCachedContextTreeHead(workspace)).toBe("abc123def456");
    expect(existsSync(join(workspace, CONTEXT_TREE_HEAD_REL))).toBe(true);
  });

  it("readCachedContextTreeHead returns null when the cache file cannot be read", () => {
    const workspace = join(tmpBase, "tree-head-cache-unreadable");
    const path = join(workspace, CONTEXT_TREE_HEAD_REL);
    mkdirSync(join(workspace, FIRST_TREE_RUNTIME_DIR), { recursive: true });
    writeFileSync(path, "abc123");
    chmodSync(path, 0);

    expect(readCachedContextTreeHead(workspace)).toBeNull();
  });

  it("readCachedContextTreeHead returns null for an empty cache file", () => {
    const workspace = join(tmpBase, "tree-head-cache-empty");
    mkdirSync(join(workspace, FIRST_TREE_RUNTIME_DIR), { recursive: true });
    writeFileSync(join(workspace, CONTEXT_TREE_HEAD_REL), "  \n");

    expect(readCachedContextTreeHead(workspace)).toBeNull();
  });

  it("writeContextTreeHead is a no-op when the HEAD is null (unknown)", () => {
    const workspace = join(tmpBase, "tree-head-null");
    mkdirSync(workspace, { recursive: true });
    writeContextTreeHead(workspace, null);
    expect(existsSync(join(workspace, CONTEXT_TREE_HEAD_REL))).toBe(false);
  });

  it("detects drift across commits when used together", () => {
    const treeDir = join(tmpBase, "tree-head-drift");
    const workspace = join(tmpBase, "tree-head-drift-ws");
    mkdirSync(workspace, { recursive: true });

    const firstHead = makeTreeRepo(treeDir);
    writeContextTreeHead(workspace, firstHead);

    // Drift: another commit upstream.
    writeFileSync(join(treeDir, "NODE.md"), "v2");
    execFileSync("git", ["add", "."], { cwd: treeDir });
    execFileSync("git", ["commit", "-q", "-m", "v2"], { cwd: treeDir });
    const secondHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: treeDir, encoding: "utf-8" }).trim();

    expect(secondHead).not.toBe(firstHead);
    expect(readContextTreeHead(treeDir)).toBe(secondHead);
    expect(readCachedContextTreeHead(workspace)).toBe(firstHead);
    // The handler compares these two; mismatch ⇒ re-bootstrap.
  });
});

describe("Bundled CLI version drift helpers", () => {
  it("resolveBundledCliVersion finds the closest package.json with a version", () => {
    // Walks up from this test file; the client package.json is the nearest
    // manifest with a version, so we should get its version string back.
    const version = resolveBundledCliVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+/u);
  });

  it("resolveBundledCliVersion returns null when no manifest is on the walk", () => {
    // Hand a URL whose dirname is the filesystem root — the walk exhausts
    // immediately. We can't `vi.mock` `node:fs` here without disturbing the
    // rest of the suite, so use a non-existent path under `/`.
    const version = resolveBundledCliVersion("file:///__no_manifest_here__/dummy.js");
    expect(version).toBeNull();
  });

  it("resolveBundledCliVersion keeps walking past a corrupt package.json", () => {
    const dir = join(tmpBase, "cli-version-corrupt", "nested");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(tmpBase, "cli-version-corrupt", "package.json"), "{not-json");

    expect(resolveBundledCliVersion(`file://${join(dir, "module.js")}`)).toMatch(/^\d+\.\d+\.\d+/u);
  });

  it("dev channel: appends a build fingerprint to the version", () => {
    // Switch to the dev binding so the resolver appends the mtime
    // suffix. Default moduleUrl points at this test bundle's own file,
    // which exists, so statSync succeeds and the suffix is present.
    setCliBinding({ binName: "first-tree-dev", packageName: null });
    const version = resolveBundledCliVersion();
    expect(version).toMatch(/\+build\.\d+$/u);
  });

  it("prod and staging channels: bare version, no fingerprint suffix", () => {
    // CI bumps the package manifest's version on every release, so the
    // fingerprint would be redundant noise in the `.agent/cli-version`
    // pin. Assert both published channels explicitly.
    setCliBinding({ binName: "first-tree", packageName: "first-tree" });
    expect(resolveBundledCliVersion()).not.toMatch(/\+build\./u);

    setCliBinding({ binName: "first-tree-staging", packageName: "first-tree-staging" });
    expect(resolveBundledCliVersion()).not.toMatch(/\+build\./u);
  });

  it("dev channel: build fingerprint changes when the module file's mtime changes", () => {
    setCliBinding({ binName: "first-tree-dev", packageName: null });
    const dir = join(tmpBase, "cli-version-fingerprint");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "9.9.9" }));
    const modulePath = join(dir, "module.js");
    writeFileSync(modulePath, "// stub");
    const moduleUrl = `file://${modulePath}`;

    utimesSync(modulePath, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    const first = resolveBundledCliVersion(moduleUrl);

    utimesSync(modulePath, new Date(1_800_000_000_000), new Date(1_800_000_000_000));
    const second = resolveBundledCliVersion(moduleUrl);

    expect(first).toMatch(/^9\.9\.9\+build\.\d+$/u);
    expect(second).toMatch(/^9\.9\.9\+build\.\d+$/u);
    expect(first).not.toBe(second);
  });

  it("dev channel: falls back to bare version when the module file is missing (statSync throws)", () => {
    setCliBinding({ binName: "first-tree-dev", packageName: null });
    const dir = join(tmpBase, "cli-version-no-mtime");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.0.1" }));
    // Synthetic module URL — statSync throws and the resolver must
    // degrade to the bare version (still drift-comparable, just not
    // build-sensitive).
    expect(resolveBundledCliVersion(`file://${join(dir, "ghost.js")}`)).toBe("0.0.1");
  });

  it("write/read roundtrip pins the CLI version for drift comparison", () => {
    const workspace = join(tmpBase, "cli-version-cache");
    mkdirSync(workspace, { recursive: true });

    expect(readCachedBundledCliVersion(workspace)).toBeNull();

    writeBundledCliVersion(workspace, "0.5.3");
    expect(readCachedBundledCliVersion(workspace)).toBe("0.5.3");
    expect(existsSync(join(workspace, BUNDLED_CLI_VERSION_REL))).toBe(true);
  });

  it("writeBundledCliVersion is a no-op when the version is null (unknown)", () => {
    const workspace = join(tmpBase, "cli-version-null");
    mkdirSync(workspace, { recursive: true });
    writeBundledCliVersion(workspace, null);
    expect(existsSync(join(workspace, BUNDLED_CLI_VERSION_REL))).toBe(false);
  });

  it("trims whitespace from the cached version on read", () => {
    const workspace = join(tmpBase, "cli-version-trim");
    mkdirSync(join(workspace, FIRST_TREE_RUNTIME_DIR), { recursive: true });
    writeFileSync(join(workspace, BUNDLED_CLI_VERSION_REL), "  0.5.3-staging.1.1  \n");
    expect(readCachedBundledCliVersion(workspace)).toBe("0.5.3-staging.1.1");
  });

  it("readCachedBundledCliVersion returns null when the cache file cannot be read", () => {
    const workspace = join(tmpBase, "cli-version-unreadable");
    const path = join(workspace, BUNDLED_CLI_VERSION_REL);
    mkdirSync(join(workspace, FIRST_TREE_RUNTIME_DIR), { recursive: true });
    writeFileSync(path, "0.5.3");
    chmodSync(path, 0);

    expect(readCachedBundledCliVersion(workspace)).toBeNull();
  });

  it("readCachedBundledCliVersion returns null for an empty cache file", () => {
    const workspace = join(tmpBase, "cli-version-empty");
    mkdirSync(join(workspace, FIRST_TREE_RUNTIME_DIR), { recursive: true });
    writeFileSync(join(workspace, BUNDLED_CLI_VERSION_REL), "  \n");

    expect(readCachedBundledCliVersion(workspace)).toBeNull();
  });
});

describe("deepEqualIdentity", () => {
  it("compares primitives, nested objects, changed values, and extra keys", () => {
    expect(deepEqualIdentity("same", "same")).toBe(true);
    expect(deepEqualIdentity("left", "right")).toBe(false);
    expect(deepEqualIdentity({ metadata: { tier: "prod" } }, { metadata: { tier: "prod" } })).toBe(true);
    expect(deepEqualIdentity({ metadata: { tier: "prod" } }, { metadata: { tier: "dev" } })).toBe(false);
    expect(deepEqualIdentity({ agentId: "agent-1" }, { agentId: "agent-1", displayName: "Agent" })).toBe(false);
    expect(deepEqualIdentity({ agentId: "agent-1" }, { agentId: "agent-1" })).toBe(true);
  });
});

/**
 * Locks in the handler-level contract around the CLI-version pin: the
 * pin MUST only be written when `installFirstTreeIntegration` actually
 * succeeded. Pinning on failure would silently mask the gap and the
 * next start would skip the retry the drift trigger exists to perform.
 *
 * Mirrors the gate in `ensureAgentBootstrap`. We drive
 * `installFirstTreeIntegration` directly with the inline installer (no
 * shell-out mocking anymore — the implementation is in-process) by
 * pointing it at a fixture skills root. Success / failure is forced by
 * giving it a complete vs incomplete bundled-skills layout.
 */
describe("CLI-version pin contract (handler invariants)", () => {
  const TREE_SKILLS = ["first-tree", "first-tree-context", "first-tree-sync"];

  it("does not overwrite the existing pin when integrate fails — next start retries", () => {
    const workspace = join(tmpBase, "cli-pin-failure-keeps-stale");
    mkdirSync(workspace, { recursive: true });

    // Pre-existing pin from an earlier successful bootstrap.
    writeBundledCliVersion(workspace, "0.5.2");
    const stalePinPath = join(workspace, BUNDLED_CLI_VERSION_REL);
    expect(readFileSync(stalePinPath, "utf-8")).toBe("0.5.2");

    // Force failure: bundled root has only first-tree, the other 3
    // tree skills are missing, so installFirstTreeIntegration returns false.
    const incomplete = makeFixtureSkillsRoot("pin-fail", [{ name: "first-tree", version: "1.0.0" }]);
    const ok = installFirstTreeIntegration({
      workspacePath: workspace,
      bundledSkillsRoot: incomplete,
      log: () => {},
    });
    expect(ok).toBe(false);

    // Handler gate: `if (ok) writeBundledCliVersion(workspace, "0.5.3")`.
    // We're asserting the OK=false branch leaves the file untouched.
    if (ok) writeBundledCliVersion(workspace, "0.5.3");
    expect(readFileSync(stalePinPath, "utf-8")).toBe("0.5.2");
  });

  it("advances the pin to the new version when integrate succeeds", () => {
    const workspace = join(tmpBase, "cli-pin-success-advances");
    mkdirSync(workspace, { recursive: true });

    writeBundledCliVersion(workspace, "0.5.2");
    const pinPath = join(workspace, BUNDLED_CLI_VERSION_REL);
    expect(readFileSync(pinPath, "utf-8")).toBe("0.5.2");

    const complete = makeFixtureSkillsRoot(
      "pin-success",
      TREE_SKILLS.map((n) => ({ name: n, version: "1.0.0" })),
    );
    const ok = installFirstTreeIntegration({
      workspacePath: workspace,
      bundledSkillsRoot: complete,
      log: () => {},
    });
    expect(ok).toBe(true);

    if (ok) writeBundledCliVersion(workspace, "0.5.3");
    expect(readFileSync(pinPath, "utf-8")).toBe("0.5.3");
  });
});
