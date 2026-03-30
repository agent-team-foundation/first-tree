import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { check, checkProgress, runVerify } from "#src/verify.js";
import { Repo } from "#src/repo.js";
import { useTmpDir, makeFramework, makeNode, makeAgentMd, makeMembers } from "./helpers.js";

// --- check ---

describe("check", () => {
  it("returns true on pass", () => {
    expect(check("my check", true)).toBe(true);
  });

  it("returns false on fail", () => {
    expect(check("my check", false)).toBe(false);
  });
});

// --- checkProgress ---

describe("checkProgress", () => {
  it("returns empty for no progress file", () => {
    const tmp = useTmpDir();
    const repo = new Repo(tmp.path);
    expect(checkProgress(repo)).toEqual([]);
  });

  it("returns empty when all checked", () => {
    const tmp = useTmpDir();
    const ct = join(tmp.path, ".context-tree");
    mkdirSync(ct);
    writeFileSync(
      join(ct, "progress.md"),
      "# Progress\n- [x] Task one\n- [x] Task two\n",
    );
    const repo = new Repo(tmp.path);
    expect(checkProgress(repo)).toEqual([]);
  });

  it("returns unchecked items", () => {
    const tmp = useTmpDir();
    const ct = join(tmp.path, ".context-tree");
    mkdirSync(ct);
    writeFileSync(
      join(ct, "progress.md"),
      "# Progress\n- [x] Done task\n- [ ] Pending task\n- [ ] Another pending\n",
    );
    const repo = new Repo(tmp.path);
    expect(checkProgress(repo)).toEqual(["Pending task", "Another pending"]);
  });

  it("returns empty for empty progress", () => {
    const tmp = useTmpDir();
    const ct = join(tmp.path, ".context-tree");
    mkdirSync(ct);
    writeFileSync(join(ct, "progress.md"), "");
    const repo = new Repo(tmp.path);
    expect(checkProgress(repo)).toEqual([]);
  });
});

// --- helpers for building a full repo ---

function buildFullRepo(root: string): void {
  mkdirSync(join(root, ".git"));
  makeFramework(root);
  writeFileSync(
    join(root, "NODE.md"),
    "---\ntitle: My Org\nowners: [alice]\n---\n# Content\n",
  );
  writeFileSync(
    join(root, "AGENT.md"),
    "<!-- BEGIN CONTEXT-TREE FRAMEWORK -->\nstuff\n<!-- END CONTEXT-TREE FRAMEWORK -->\n",
  );
  makeMembers(root, 1);
}

const passValidator = () => ({ exitCode: 0 });
const failValidator = () => ({ exitCode: 1 });

// --- runVerify — all passing ---

describe("runVerify all passing", () => {
  it("returns 0 when all checks pass", () => {
    const tmp = useTmpDir();
    buildFullRepo(tmp.path);
    const repo = new Repo(tmp.path);
    const ret = runVerify(repo, passValidator);
    expect(ret).toBe(0);
  });
});

// --- runVerify — failing checks ---

describe("runVerify failing", () => {
  it("fails on empty repo", () => {
    const tmp = useTmpDir();
    const repo = new Repo(tmp.path);
    const ret = runVerify(repo, passValidator);
    expect(ret).toBe(1);
  });

  it("fails when AGENT.md is missing", () => {
    const tmp = useTmpDir();
    makeFramework(tmp.path);
    writeFileSync(
      join(tmp.path, "NODE.md"),
      "---\ntitle: My Org\nowners: [alice]\n---\n",
    );
    const repo = new Repo(tmp.path);
    const ret = runVerify(repo, passValidator);
    expect(ret).toBe(1);
  });

  it("fails when node validation returns non-zero", () => {
    const tmp = useTmpDir();
    buildFullRepo(tmp.path);
    const repo = new Repo(tmp.path);
    const ret = runVerify(repo, failValidator);
    expect(ret).toBe(1);
  });
});
