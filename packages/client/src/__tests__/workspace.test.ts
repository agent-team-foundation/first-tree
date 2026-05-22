import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FIRST_TREE_WORKSPACE_MARKER } from "../runtime/bootstrap.js";
import {
  acquireAgentHome,
  acquireWorkspace,
  cleanWorkspaces,
  clearWorkspaceInitComplete,
  INIT_COMPLETE_SENTINEL_REL,
  markWorkspaceInitComplete,
} from "../runtime/workspace.js";

/**
 * Per agent-session-cwd-redesign (proposals/2026-05-19) the runtime cwd is
 * **per-agent**, not per-chat. Self-healing therefore cannot rm the directory
 * any more (would drop predeclared worktrees and persistent agent state);
 * instead the sentinel's absence signals "re-run runBootstrap" — verified by
 * the handler-level test, not here. The contracts pinned in this file:
 *
 *  - acquireAgentHome is idempotent: creates the dir on first call, returns
 *    the same path thereafter, never wipes existing content.
 *  - The boundary marker (`.first-tree-workspace`) is written once at the
 *    agent home root so Codex's `project_root_markers` stops there.
 *  - The sentinel write/clear pair is the drift-detection knob: clear it when
 *    Context Tree commit changes, write it after bootstrap succeeds.
 */

let root: string;
const AGENT_NAME = "test-agent";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ftt-ws-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("acquireAgentHome", () => {
  it("creates the agent home and writes the boundary marker on first call", () => {
    const home = join(root, AGENT_NAME);
    const cwd = acquireAgentHome(home);

    expect(cwd).toBe(home);
    expect(existsSync(home)).toBe(true);
    expect(existsSync(join(home, FIRST_TREE_WORKSPACE_MARKER))).toBe(true);
  });

  it("is idempotent — second call preserves user state and does not rewrite the marker", () => {
    const home = join(root, AGENT_NAME);
    acquireAgentHome(home);

    // Simulate persistent agent state accumulated across sessions.
    writeFileSync(join(home, "memory.txt"), "important", "utf-8");
    mkdirSync(join(home, "worktrees", "some-repo"), { recursive: true });
    writeFileSync(join(home, "worktrees", "some-repo", "file.txt"), "work", "utf-8");

    acquireAgentHome(home);

    expect(readFileSync(join(home, "memory.txt"), "utf-8")).toBe("important");
    expect(readFileSync(join(home, "worktrees", "some-repo", "file.txt"), "utf-8")).toBe("work");
  });

  it("does not wipe an existing home even when the sentinel is missing", () => {
    // Per the new model: half-baked is healed by re-running runBootstrap,
    // NOT by rming the directory. acquireAgentHome must not touch contents.
    const home = join(root, AGENT_NAME);
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, FIRST_TREE_WORKSPACE_MARKER), "", "utf-8");
    writeFileSync(join(home, "preexisting.txt"), "keep me", "utf-8");

    acquireAgentHome(home);

    expect(existsSync(join(home, "preexisting.txt"))).toBe(true);
  });
});

describe("markWorkspaceInitComplete / clearWorkspaceInitComplete", () => {
  it("writes the sentinel with a timestamped JSON body", () => {
    const home = acquireAgentHome(join(root, AGENT_NAME));
    markWorkspaceInitComplete(home);

    const sentinelPath = join(home, INIT_COMPLETE_SENTINEL_REL);
    expect(existsSync(sentinelPath)).toBe(true);
    const body = JSON.parse(readFileSync(sentinelPath, "utf-8"));
    expect(body.schemaVersion).toBe(1);
    expect(typeof body.completedAt).toBe("string");
    expect(new Date(body.completedAt).toString()).not.toBe("Invalid Date");
  });

  it("creates .agent/ if missing (defensive)", () => {
    const home = acquireAgentHome(join(root, AGENT_NAME));
    markWorkspaceInitComplete(home);
    expect(existsSync(join(home, ".agent"))).toBe(true);
  });

  it("is idempotent — writing twice leaves a valid sentinel", () => {
    const home = acquireAgentHome(join(root, AGENT_NAME));
    markWorkspaceInitComplete(home);
    markWorkspaceInitComplete(home);
    const body = JSON.parse(readFileSync(join(home, INIT_COMPLETE_SENTINEL_REL), "utf-8"));
    expect(body.schemaVersion).toBe(1);
  });

  it("clearWorkspaceInitComplete removes the sentinel, leaving everything else alone", () => {
    const home = acquireAgentHome(join(root, AGENT_NAME));
    markWorkspaceInitComplete(home);
    writeFileSync(join(home, ".agent", "identity.json"), "{}", "utf-8");

    clearWorkspaceInitComplete(home);

    expect(existsSync(join(home, INIT_COMPLETE_SENTINEL_REL))).toBe(false);
    expect(existsSync(join(home, ".agent", "identity.json"))).toBe(true);
    expect(existsSync(join(home, FIRST_TREE_WORKSPACE_MARKER))).toBe(true);
  });

  it("clearWorkspaceInitComplete is a no-op if the sentinel is already absent", () => {
    const home = acquireAgentHome(join(root, AGENT_NAME));
    // Never marked complete in the first place.
    expect(() => clearWorkspaceInitComplete(home)).not.toThrow();
  });
});

describe("cleanWorkspaces (deprecated, no-op)", () => {
  it("returns an empty list and does not touch the filesystem", () => {
    const home = acquireAgentHome(join(root, AGENT_NAME));
    writeFileSync(join(home, "memory.txt"), "important", "utf-8");

    // Even when called with an empty active set and a zero TTL — pre-refactor
    // these args would have triggered aggressive deletion — the new contract
    // is no-op.
    const removed = cleanWorkspaces(root, new Set<string>(), 0);

    expect(removed).toEqual([]);
    expect(existsSync(join(home, "memory.txt"))).toBe(true);
  });
});

describe("acquireWorkspace (deprecated legacy shim)", () => {
  it("still returns the legacy per-chat path so external callers compile", () => {
    const dir = acquireWorkspace(root, "chat-abc");
    expect(dir).toBe(join(root, "chat-abc"));
    expect(existsSync(dir)).toBe(true);
  });

  it("does NOT wipe an existing legacy directory", () => {
    // Production handlers no longer call this; the shim must therefore not
    // implement the old half-baked rm logic.
    const dir = join(root, "chat-abc");
    mkdirSync(join(dir, ".agent"), { recursive: true });
    writeFileSync(join(dir, FIRST_TREE_WORKSPACE_MARKER), "", "utf-8");
    writeFileSync(join(dir, "leftover.txt"), "untouched", "utf-8");

    acquireWorkspace(root, "chat-abc");

    expect(existsSync(join(dir, "leftover.txt"))).toBe(true);
    expect(existsSync(join(dir, FIRST_TREE_WORKSPACE_MARKER))).toBe(true);
  });
});
