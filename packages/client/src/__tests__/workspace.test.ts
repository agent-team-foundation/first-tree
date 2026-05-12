import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FIRST_TREE_WORKSPACE_MARKER } from "../runtime/bootstrap.js";
import { acquireWorkspace, INIT_COMPLETE_SENTINEL_REL, markWorkspaceInitComplete } from "../runtime/workspace.js";

/**
 * Pin the F3 self-healing contract from
 * docs/workspace-session-branch-collision-fix-design.md §3.4:
 *
 * `acquireWorkspace` wipes a directory iff it carries the boundary marker
 * (`.first-tree-workspace`, written in stage 1) BUT is missing the
 * completion sentinel (`.agent/init-complete`, written after stage 2). That
 * shape only arises when the previous session start crashed between the
 * two writes; healing makes the next start get a clean slate instead of
 * trying to attach to a phantom worktree.
 */

let root: string;
const CHAT_ID = "chat-abc";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ftt-ws-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("acquireWorkspace — self-healing", () => {
  it("creates a fresh directory when nothing exists", () => {
    const cwd = acquireWorkspace(root, CHAT_ID);
    expect(cwd).toBe(join(root, CHAT_ID));
    expect(existsSync(cwd)).toBe(true);
  });

  it("preserves a healthy directory (boundary marker + sentinel both present)", () => {
    const cwd = join(root, CHAT_ID);
    mkdirSync(join(cwd, ".agent"), { recursive: true });
    writeFileSync(join(cwd, FIRST_TREE_WORKSPACE_MARKER), "", "utf-8");
    writeFileSync(join(cwd, INIT_COMPLETE_SENTINEL_REL), JSON.stringify({ schemaVersion: 1 }), "utf-8");
    writeFileSync(join(cwd, "user-data.txt"), "keep me", "utf-8");

    acquireWorkspace(root, CHAT_ID);

    expect(existsSync(join(cwd, "user-data.txt"))).toBe(true);
    expect(readFileSync(join(cwd, "user-data.txt"), "utf-8")).toBe("keep me");
  });

  it("wipes a half-baked directory (boundary marker present, sentinel missing)", () => {
    const cwd = join(root, CHAT_ID);
    mkdirSync(join(cwd, ".agent"), { recursive: true });
    writeFileSync(join(cwd, FIRST_TREE_WORKSPACE_MARKER), "", "utf-8");
    // No init-complete — half-baked.
    writeFileSync(join(cwd, "stale-data.txt"), "should be wiped", "utf-8");

    acquireWorkspace(root, CHAT_ID);

    expect(existsSync(cwd)).toBe(true);
    expect(existsSync(join(cwd, "stale-data.txt"))).toBe(false);
    expect(existsSync(join(cwd, FIRST_TREE_WORKSPACE_MARKER))).toBe(false);
  });

  it("does NOT wipe a directory that lacks the boundary marker entirely", () => {
    // No boundary marker means stage 1 never ran here — could be a user-
    // created scratch dir or a partially-populated workspace from a
    // pre-F3 version. Either way, healing rules don't apply.
    const cwd = join(root, CHAT_ID);
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, "user-data.txt"), "keep me", "utf-8");

    acquireWorkspace(root, CHAT_ID);

    expect(existsSync(join(cwd, "user-data.txt"))).toBe(true);
  });
});

describe("markWorkspaceInitComplete", () => {
  it("writes the sentinel with a timestamped JSON body", () => {
    const cwd = acquireWorkspace(root, CHAT_ID);
    markWorkspaceInitComplete(cwd);

    const sentinelPath = join(cwd, INIT_COMPLETE_SENTINEL_REL);
    expect(existsSync(sentinelPath)).toBe(true);
    const body = JSON.parse(readFileSync(sentinelPath, "utf-8"));
    expect(body.schemaVersion).toBe(1);
    expect(typeof body.completedAt).toBe("string");
    expect(new Date(body.completedAt).toString()).not.toBe("Invalid Date");
  });

  it("creates .agent/ if missing (defensive — callers normally bootstrap first)", () => {
    const cwd = acquireWorkspace(root, CHAT_ID);
    markWorkspaceInitComplete(cwd);
    expect(existsSync(join(cwd, ".agent"))).toBe(true);
  });

  it("is idempotent — writing twice leaves a valid sentinel", () => {
    const cwd = acquireWorkspace(root, CHAT_ID);
    markWorkspaceInitComplete(cwd);
    const firstBody = readFileSync(join(cwd, INIT_COMPLETE_SENTINEL_REL), "utf-8");
    markWorkspaceInitComplete(cwd);
    const secondBody = readFileSync(join(cwd, INIT_COMPLETE_SENTINEL_REL), "utf-8");
    // Body may differ (timestamp updates), but the JSON shape is valid both times.
    expect(JSON.parse(firstBody).schemaVersion).toBe(1);
    expect(JSON.parse(secondBody).schemaVersion).toBe(1);
  });
});
