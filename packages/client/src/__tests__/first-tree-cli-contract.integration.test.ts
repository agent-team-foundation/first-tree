import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  __setTestInstallExec,
  bootstrapWorkspace,
  type InstallFirstTreeIntegrationExec,
  installFirstTreeIntegration,
} from "../runtime/bootstrap.js";
import { setCliBinding } from "../runtime/cli-binding.js";
import type { AgentIdentity } from "../runtime/handler.js";

// This file probes the real `first-tree` binary (via the PATH shim installed
// per test) — the contract covers the prod CLI shape. Pin the binding to
// prod so `bootstrapWorkspace` and `installFirstTreeIntegration` invoke the
// binary the test scaffolding expects (and the `HAS_FIRST_TREE_CLI` probe
// below already checks the same name).
beforeAll(() => {
  setCliBinding({ binName: "first-tree", packageName: "first-tree" });
  // `vitest.setup.ts` neuters `defaultInstallExec` for every test file so
  // handler-level fast tests don't shell out unnecessarily. This file
  // *wants* the real shell-out because that's the contract under test —
  // clear the override locally and restore it on teardown so neighbouring
  // tests in the same vitest run keep their fast path.
  __setTestInstallExec(null);
});
afterAll(() => {
  __setTestInstallExec(() => {
    // Restore the global no-op so subsequent test files re-enter with the
    // setup-installed default.
  });
});

/**
 * Production `defaultInstallExec` uses `stdio: "pipe"` and discards both
 * streams on success — fine for runtime, useless for debugging. We swap in
 * one that buffers both streams so an unexpected silent-success failure
 * (CLI writes nothing despite exit 0) leaves a trail.
 */
function tracingExec(captured: string[]): InstallFirstTreeIntegrationExec {
  return (command, args, options) => {
    let stdout = "";
    let stderr = "";
    try {
      stdout = execFileSync(command, args, {
        cwd: options.cwd,
        stdio: "pipe",
        timeout: options.timeout,
        encoding: "utf-8",
      });
    } catch (err) {
      const e = err as { stdout?: Buffer; stderr?: Buffer; status?: number | null };
      stdout = e.stdout?.toString() ?? "";
      stderr = e.stderr?.toString() ?? "";
      captured.push(`exit=${e.status}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
      throw err;
    }
    captured.push(`exit=0\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  };
}

/**
 * Contract test against the real `first-tree` CLI.
 *
 * Why this file exists: the mock-exec unit tests can't catch protocol drift
 * between the runtime's argv construction and the first-tree CLI's accepted flags.
 * `installFirstTreeIntegration` now drives `tree skill install --root
 * <workspace>` per session, which materialises the shipped skill payloads
 * under `.agents/skills/` and `.claude/skills/`. Framework files
 * (workspace.json, AGENTS.md / CLAUDE.md) are written once by `tree init`
 * during onboarding, not by the per-session hook this file exercises.
 *
 * Runs against the in-tree CLI source via a PATH shim. That keeps the contract
 * stable even when a developer has a packaged/global `first-tree` installed
 * whose bundled skills do not match this checkout.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const FIRST_TREE_CLI_SOURCE = join(REPO_ROOT, "apps", "cli", "src", "cli", "index.ts");
const TSX_BIN = join(REPO_ROOT, "apps", "cli", "node_modules", ".bin", "tsx");
const HAS_FIRST_TREE_CLI = (() => {
  try {
    if (!existsSync(FIRST_TREE_CLI_SOURCE) || !existsSync(TSX_BIN)) return false;
    execFileSync(TSX_BIN, [FIRST_TREE_CLI_SOURCE, "--version"], { stdio: "ignore", timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
})();

/**
 * Tmpdir lives under `os.tmpdir()` (typically `/var/folders/...` on macOS),
 * NOT under the worktree. first-tree CLI's project-root detection walks
 * upward from cwd looking for a git checkout — if we put the fixture under
 * the worktree, the CLI would climb out and land on the worktree root, then
 * write its binding files there. That's not just a wrong fixture; it would
 * actively trash the developer's repo. Real production paths
 * (`~/.first-tree/data/workspaces/...`) sit outside any git repo, so
 * this also matches the production layout.
 */
let tmpBase: string;
let originalPath: string | undefined;

function installFirstTreePathShim(binDir: string): void {
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "first-tree"), `#!/bin/sh\nexec "${TSX_BIN}" "${FIRST_TREE_CLI_SOURCE}" "$@"\n`, {
    encoding: "utf-8",
    mode: 0o755,
  });
  originalPath = process.env.PATH;
  process.env.PATH = [binDir, originalPath].filter(Boolean).join(delimiter);
}

/**
 * Initialise a fake context-tree git repo. The runtime hands
 * `installFirstTreeIntegration` a path that came out of `syncContextTree`
 * (a fresh `git clone`), so the fixture mirrors that — even though the
 * post-W1 `tree skill install` only writes skill payloads at the
 * workspace root and never reads the tree checkout itself, keeping the
 * fixture realistic catches regressions in callers that still rely on
 * the cloned tree being present.
 */
function makeFakeTreeRepo(dir: string, remoteUrl?: string): void {
  mkdirSync(dir, { recursive: true });
  const opts = { cwd: dir, stdio: "ignore" as const };
  execFileSync("git", ["init", "-q"], opts);
  execFileSync("git", ["-c", "init.defaultBranch=main", "checkout", "-q", "-B", "main"], opts);
  execFileSync("git", ["config", "user.email", "test@test"], opts);
  execFileSync("git", ["config", "user.name", "test"], opts);
  writeFileSync(join(dir, "AGENT.md"), "# Agent operating instructions\n", "utf-8");
  writeFileSync(join(dir, "NODE.md"), "# Root domain map\n", "utf-8");
  execFileSync("git", ["add", "-A"], opts);
  execFileSync("git", ["commit", "-q", "-m", "init"], opts);
  if (remoteUrl) {
    execFileSync("git", ["remote", "add", "origin", remoteUrl], opts);
  }
}

describe.skipIf(!HAS_FIRST_TREE_CLI)("first-tree CLI skill install contract", () => {
  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), "ft-cli-contract-"));
    installFirstTreePathShim(join(tmpBase, "bin"));
  });
  afterEach(() => {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    try {
      rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("skill install materialises the shipped skill payloads at the workspace root", () => {
    const workspace = join(tmpBase, "ws-happy");
    const treePath = join(tmpBase, "tree-happy");
    mkdirSync(workspace, { recursive: true });
    makeFakeTreeRepo(treePath);

    const logs: string[] = [];
    const captured: string[] = [];
    const result = installFirstTreeIntegration({
      workspacePath: workspace,
      contextTreePath: treePath,
      workspaceId: "test-agent",
      treeRepoUrl: "https://example.com/org/tree.git",
      log: (m) => logs.push(m),
      exec: tracingExec(captured),
    });

    if (!result) {
      throw new Error(
        `installFirstTreeIntegration returned false. Logs:\n${logs.join("\n")}\n\nCLI output:\n${captured.join("\n---\n")}`,
      );
    }

    // Diagnostic: when an assertion below fails, this surfaces what the CLI
    // actually wrote so the next debugger doesn't have to re-run by hand.
    const wsContents = readdirSync(workspace);
    const diagnostic = `ws=${workspace}\nws contents: ${JSON.stringify(wsContents)}\nlogs:\n${logs.join("\n")}\n\nCLI output:\n${captured.join("\n---\n")}`;

    // Skill files materialised under both .agents/ (Codex) and .claude/ (Claude Code).
    expect(existsSync(join(workspace, ".agents", "skills", "first-tree", "SKILL.md")), diagnostic).toBe(true);
    expect(existsSync(join(workspace, ".claude", "skills", "first-tree"))).toBe(true);
  });

  it("end-to-end: bootstrapWorkspace + installFirstTreeIntegration mirror what handler.start does", () => {
    // This exercises the two-step bootstrap path a claude-code session
    // actually runs at start(): copy AGENT.md/NODE.md into .agent/context/,
    // write identity.json, then shell out to first-tree to drop the skill
    // payloads into the workspace.
    const workspace = join(tmpBase, "ws-e2e");
    const treePath = join(tmpBase, "tree-e2e");
    mkdirSync(workspace, { recursive: true });
    makeFakeTreeRepo(treePath, "https://example.com/org/tree.git");

    const identity: AgentIdentity = {
      agentId: "agent-uuid-xyz",
      inboxId: "inbox-xyz",
      displayName: "Test Agent",
      type: "agent",
      visibility: "organization",
      delegateMention: null,
      metadata: {},
    };

    bootstrapWorkspace({
      workspacePath: workspace,
      identity,
      contextTreePath: treePath,
      serverUrl: "https://first-tree.example.com",
    });

    // bootstrap should have produced the .agent layout the agent reads first.
    const identityJson = JSON.parse(readFileSync(join(workspace, ".agent", "identity.json"), "utf-8")) as Record<
      string,
      unknown
    >;
    expect(identityJson.agentId).toBe("agent-uuid-xyz");
    expect(identityJson.contextTreePath).toBe(treePath);
    // The unified briefing now references the tree by path; the legacy
    // `.agent/context/` staging copies are no longer written. See the
    // AGENTS.md restructure follow-up to PR #797.
    expect(existsSync(join(workspace, ".agent", "context"))).toBe(false);
    expect(existsSync(join(workspace, ".first-tree-workspace"))).toBe(true);

    const logs: string[] = [];
    const result = installFirstTreeIntegration({
      workspacePath: workspace,
      contextTreePath: treePath,
      workspaceId: "test-agent",
      treeRepoUrl: "https://example.com/org/tree.git",
      log: (m) => logs.push(m),
    });
    expect(result, `install failed:\n${logs.join("\n")}`).toBe(true);

    // Skill payloads materialised on top of the existing .agent layout.
    expect(existsSync(join(workspace, ".agents", "skills", "first-tree", "SKILL.md"))).toBe(true);
    expect(existsSync(join(workspace, ".claude", "skills", "first-tree"))).toBe(true);
  });
});
