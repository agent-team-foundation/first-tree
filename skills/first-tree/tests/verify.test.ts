import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { check, checkProgress, runVerify } from "#skill/engine/verify.js";
import { Repo } from "#skill/engine/repo.js";
import {
  AGENT_INSTRUCTIONS_FILE,
  INSTALLED_PROGRESS,
  LEGACY_PROGRESS,
} from "#skill/engine/runtime/asset-loader.js";
import {
  useTmpDir,
  makeAgentsMd,
  makeFramework,
  makeLegacyFramework,
  makeNode,
  makeMembers,
} from "./helpers.js";

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
    mkdirSync(join(tmp.path, "skills", "first-tree"), { recursive: true });
    writeFileSync(
      join(tmp.path, INSTALLED_PROGRESS),
      "# Progress\n- [x] Task one\n- [x] Task two\n",
    );
    const repo = new Repo(tmp.path);
    expect(checkProgress(repo)).toEqual([]);
  });

  it("returns unchecked items", () => {
    const tmp = useTmpDir();
    mkdirSync(join(tmp.path, "skills", "first-tree"), { recursive: true });
    writeFileSync(
      join(tmp.path, INSTALLED_PROGRESS),
      "# Progress\n- [x] Done task\n- [ ] Pending task\n- [ ] Another pending\n",
    );
    const repo = new Repo(tmp.path);
    expect(checkProgress(repo)).toEqual(["Pending task", "Another pending"]);
  });

  it("returns empty for empty progress", () => {
    const tmp = useTmpDir();
    mkdirSync(join(tmp.path, "skills", "first-tree"), { recursive: true });
    writeFileSync(join(tmp.path, INSTALLED_PROGRESS), "");
    const repo = new Repo(tmp.path);
    expect(checkProgress(repo)).toEqual([]);
  });

  it("falls back to the legacy progress file", () => {
    const tmp = useTmpDir();
    makeLegacyFramework(tmp.path);
    writeFileSync(
      join(tmp.path, LEGACY_PROGRESS),
      "# Progress\n- [ ] Legacy task\n",
    );
    const repo = new Repo(tmp.path);
    expect(checkProgress(repo)).toEqual(["Legacy task"]);
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
  makeAgentsMd(root, { markers: true });
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

  it("fails when AGENTS.md is missing", () => {
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

  it("fails when only legacy AGENT.md exists", () => {
    const tmp = useTmpDir();
    mkdirSync(join(tmp.path, ".git"));
    makeFramework(tmp.path);
    makeNode(tmp.path);
    makeAgentsMd(tmp.path, { legacyName: true, markers: true, userContent: true });
    makeMembers(tmp.path, 1);
    const repo = new Repo(tmp.path);
    const ret = runVerify(repo, passValidator);
    expect(existsSync(join(tmp.path, AGENT_INSTRUCTIONS_FILE))).toBe(false);
    expect(ret).toBe(1);
  });

  it("fails when legacy AGENT.md remains alongside AGENTS.md", () => {
    const tmp = useTmpDir();
    buildFullRepo(tmp.path);
    makeAgentsMd(tmp.path, { legacyName: true, markers: true, userContent: true });
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
