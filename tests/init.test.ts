import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatTaskList, writeProgress, runInit } from "#src/init.js";
import { Repo } from "#src/repo.js";
import { useTmpDir, makeFramework } from "./helpers.js";

// --- formatTaskList ---

describe("formatTaskList", () => {
  it("produces markdown heading", () => {
    const groups = [
      { group: "Framework", order: 1, tasks: ["Install framework"] },
    ];
    const output = formatTaskList(groups);
    expect(output).toMatch(/^# Context Tree Init/);
  });

  it("includes group heading", () => {
    const groups = [
      { group: "Framework", order: 1, tasks: ["Install framework"] },
    ];
    const output = formatTaskList(groups);
    expect(output).toContain("## Framework");
  });

  it("includes task as checkbox", () => {
    const groups = [
      { group: "Root Node", order: 2, tasks: ["Fix title"] },
    ];
    const output = formatTaskList(groups);
    expect(output).toContain("- [ ] Fix title");
  });

  it("handles multiple groups", () => {
    const groups = [
      { group: "A", order: 1, tasks: ["task-a1", "task-a2"] },
      { group: "B", order: 2, tasks: ["task-b1"] },
    ];
    const output = formatTaskList(groups);
    expect(output).toContain("## A");
    expect(output).toContain("## B");
    expect(output).toContain("- [ ] task-a1");
    expect(output).toContain("- [ ] task-a2");
    expect(output).toContain("- [ ] task-b1");
  });

  it("includes verification section", () => {
    const groups = [{ group: "G", order: 1, tasks: ["t"] }];
    const output = formatTaskList(groups);
    expect(output).toContain("## Verification");
    expect(output).toContain("context-tree verify");
  });

  it("handles empty groups", () => {
    const output = formatTaskList([]);
    expect(output).toContain("# Context Tree Init");
    expect(output).toContain("## Verification");
  });
});

// --- writeProgress ---

describe("writeProgress", () => {
  it("writes to correct path", () => {
    const tmp = useTmpDir();
    const repo = new Repo(tmp.path);
    writeProgress(repo, "# hello\n");
    const progress = join(tmp.path, ".context-tree", "progress.md");
    expect(readFileSync(progress, "utf-8")).toBe("# hello\n");
  });

  it("creates directory if missing", () => {
    const tmp = useTmpDir();
    const repo = new Repo(tmp.path);
    writeProgress(repo, "content");
    const progress = join(tmp.path, ".context-tree", "progress.md");
    expect(readFileSync(progress, "utf-8")).toBe("content");
  });

  it("overwrites existing file", () => {
    const tmp = useTmpDir();
    const ct = join(tmp.path, ".context-tree");
    mkdirSync(ct);
    writeFileSync(join(ct, "progress.md"), "old");
    const repo = new Repo(tmp.path);
    writeProgress(repo, "new");
    expect(readFileSync(join(ct, "progress.md"), "utf-8")).toBe("new");
  });
});

// --- runInit — guard logic (no network) ---

describe("runInit", () => {
  it("errors when not a git repo", () => {
    const tmp = useTmpDir();
    const repo = new Repo(tmp.path);
    const ret = runInit(repo);
    expect(ret).toBe(1);
  });

  it("skips clone when framework exists", () => {
    const tmp = useTmpDir();
    mkdirSync(join(tmp.path, ".git"));
    makeFramework(tmp.path);
    const repo = new Repo(tmp.path);
    // Should not throw or try to clone — just evaluate rules
    const ret = runInit(repo);
    expect(ret).toBe(0);
  });
});
