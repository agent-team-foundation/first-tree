import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsMode = vi.hoisted(() => ({
  mode: "normal" as
    | "normal"
    | "bindings-readdir-error"
    | "empty-runtime-readdir-error"
    | "tree-rename-moves-then-throws"
    | "rollback-rename-throws",
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readdirSync: ((path: Parameters<typeof actual.readdirSync>[0], options?: unknown) => {
      const text = String(path);
      if (fsMode.mode === "bindings-readdir-error" && text.endsWith("/.first-tree/bindings")) {
        throw new Error("bindings denied");
      }
      if (fsMode.mode === "empty-runtime-readdir-error" && text.endsWith("/api/.first-tree")) {
        throw new Error("runtime dir denied");
      }
      return (actual.readdirSync as (...args: unknown[]) => unknown)(path, options);
    }) as typeof actual.readdirSync,
    renameSync: ((oldPath: Parameters<typeof actual.renameSync>[0], newPath: Parameters<typeof actual.renameSync>[1]) => {
      const oldText = String(oldPath);
      const newText = String(newPath);
      if (
        fsMode.mode === "tree-rename-moves-then-throws" &&
        oldText.endsWith("/context") &&
        newText.endsWith("/api-workspace/context")
      ) {
        actual.renameSync(oldPath, newPath);
        throw new Error("tree move failed after move");
      }
      if (
        fsMode.mode === "rollback-rename-throws" &&
        oldText.endsWith("/context") &&
        newText.endsWith("/api-workspace/context")
      ) {
        throw new Error("tree move failed before move");
      }
      if (
        fsMode.mode === "rollback-rename-throws" &&
        oldText.endsWith("/api-workspace/api") &&
        newText.endsWith("/api")
      ) {
        throw new Error("rollback denied");
      }
      return actual.renameSync(oldPath, newPath);
    }) as typeof actual.renameSync,
  };
});

let tmpRoot = "";

function makeRepo(parentDir: string, name: string): string {
  const repoDir = join(parentDir, name);
  mkdirSync(repoDir, { recursive: true });
  execSync("git init --quiet", { cwd: repoDir });
  return repoDir;
}

function writeJson(filePath: string, body: unknown): void {
  mkdirSync(join(filePath, ".."), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(body, null, 2)}\n`, "utf-8");
}

function writeFile(filePath: string, body: string): void {
  mkdirSync(join(filePath, ".."), { recursive: true });
  writeFileSync(filePath, body, "utf-8");
}

function makeWorkspace(): { workspaceRoot: string; treeRoot: string; sourceRoot: string } {
  const workspaceRoot = tmpRoot;
  writeFile(join(workspaceRoot, ".first-tree-workspace"), "");
  const treeRoot = makeRepo(workspaceRoot, "context");
  mkdirSync(join(treeRoot, ".first-tree", "bindings"), { recursive: true });
  writeJson(join(treeRoot, ".first-tree", "bindings", "api.json"), { sourceName: "api" });
  const sourceRoot = makeRepo(workspaceRoot, "api");
  writeJson(join(sourceRoot, ".first-tree", "source.json"), { tree: { treeRepoName: "context" } });
  return { workspaceRoot, treeRoot, sourceRoot };
}

function makePromotable(): { sourceRoot: string; treeRoot: string } {
  const sourceRoot = makeRepo(tmpRoot, "api");
  const treeRoot = makeRepo(tmpRoot, "context");
  writeJson(join(sourceRoot, ".first-tree", "source.json"), {
    tree: { localPath: "../context" },
  });
  return { sourceRoot, treeRoot };
}

beforeEach(() => {
  fsMode.mode = "normal";
  tmpRoot = mkdtempSync(join(tmpdir(), "ft-migrate-fs-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("migrate workspace fs edge paths", () => {
  it("falls back to filesystem source discovery when bindings cannot be enumerated", async () => {
    const fixture = makeWorkspace();
    fsMode.mode = "bindings-readdir-error";
    const { detectMigrationState } = await import("../core/migrate-workspace.js");

    const detection = detectMigrationState(fixture.workspaceRoot);

    expect(detection.kind).toBe("workspace");
    if (detection.kind !== "workspace") throw new Error("expected workspace");
    expect(detection.sourceRoots).toEqual([fixture.sourceRoot]);
  });

  it("keeps an empty source runtime dir when emptiness cannot be inspected", async () => {
    const fixture = makeWorkspace();
    fsMode.mode = "empty-runtime-readdir-error";
    const { detectMigrationState, migrateWorkspaceToW1 } = await import("../core/migrate-workspace.js");
    const detection = detectMigrationState(fixture.workspaceRoot);
    if (detection.kind !== "workspace") throw new Error("expected workspace");

    const result = migrateWorkspaceToW1(detection);

    expect(result.removed).toContainEqual({ path: "api/.first-tree/source.json", kind: "source-state" });
    expect(result.removed).not.toContainEqual({ path: "api/.first-tree", kind: "source-state-dir" });
    expect(existsSync(join(fixture.sourceRoot, ".first-tree"))).toBe(true);
  });

  it("rolls source and tree moves back when promotion fails after the tree move", async () => {
    const fixture = makePromotable();
    fsMode.mode = "tree-rename-moves-then-throws";
    const { detectMigrationState, promoteToWorkspace } = await import("../core/migrate-workspace.js");
    const detection = detectMigrationState(fixture.sourceRoot);
    if (detection.kind !== "promotable-source") throw new Error("expected promotable source");

    expect(() => promoteToWorkspace(detection)).toThrow("tree move failed after move");

    expect(existsSync(fixture.sourceRoot)).toBe(true);
    expect(existsSync(fixture.treeRoot)).toBe(true);
    expect(existsSync(join(tmpRoot, "api-workspace"))).toBe(false);
  });

  it("preserves the original promotion error when rollback cleanup also fails", async () => {
    const fixture = makePromotable();
    fsMode.mode = "rollback-rename-throws";
    const { detectMigrationState, promoteToWorkspace } = await import("../core/migrate-workspace.js");
    const detection = detectMigrationState(fixture.sourceRoot);
    if (detection.kind !== "promotable-source") throw new Error("expected promotable source");

    expect(() => promoteToWorkspace(detection)).toThrow("tree move failed before move");

    expect(existsSync(join(tmpRoot, "api-workspace", "api"))).toBe(true);
    expect(readFileSync(join(fixture.treeRoot, ".git", "HEAD"), "utf8")).toContain("ref:");
  });
});
