import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  symlinkSync: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    symlinkSync: fsMocks.symlinkSync,
  };
});

import { installCoreSkills, writeAgentBriefing } from "../runtime/bootstrap.js";

const originalPlatform = process.platform;
const CORE_SKILLS = [
  "context-tree-review",
  "first-tree-welcome",
  "first-tree-seed",
  "first-tree-file-bug",
  "first-tree-read",
  "first-tree-write",
] as const;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
}

function symlinkError(code: "EPERM" | "EACCES"): NodeJS.ErrnoException {
  return Object.assign(new Error(`symlink ${code}`), { code });
}

function makeFixtureSkillsRoot(parent: string, version: string, label: string): string {
  const root = join(parent, `skills-${label}`);
  mkdirSync(root, { recursive: true });
  for (const name of CORE_SKILLS) {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\n---\nfixture ${label} for ${name}\n`);
    writeFileSync(join(dir, "VERSION"), version);
  }
  mkdirSync(join(root, "first-tree-seed", "nested"), { recursive: true });
  writeFileSync(join(root, "first-tree-seed", "nested", "extra.txt"), `extra ${label}\n`);
  return root;
}

describe("Windows symlink fallbacks", () => {
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), "ft-win-symlink-"));
    fsMocks.symlinkSync.mockReset();
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
    setPlatform(originalPlatform);
  });

  it.each([
    "EPERM",
    "EACCES",
  ] as const)("writes CLAUDE.md as a regular file on Windows %s and keeps later briefing updates in sync", (code) => {
    setPlatform("win32");
    fsMocks.symlinkSync.mockImplementation(() => {
      throw symlinkError(code);
    });
    const workspace = join(tmpBase, `briefing-${code}`);
    mkdirSync(workspace, { recursive: true });

    writeAgentBriefing(workspace, "first briefing");
    expect(readFileSync(join(workspace, "AGENTS.md"), "utf-8")).toBe("first briefing");
    expect(readFileSync(join(workspace, "CLAUDE.md"), "utf-8")).toBe("first briefing");
    expect(lstatSync(join(workspace, "CLAUDE.md")).isFile()).toBe(true);
    expect(lstatSync(join(workspace, "CLAUDE.md")).isSymbolicLink()).toBe(false);

    writeAgentBriefing(workspace, "updated briefing");
    expect(readFileSync(join(workspace, "AGENTS.md"), "utf-8")).toBe("updated briefing");
    expect(readFileSync(join(workspace, "CLAUDE.md"), "utf-8")).toBe("updated briefing");
  });

  it("does not swallow non-Windows symlink permission errors", () => {
    setPlatform("linux");
    fsMocks.symlinkSync.mockImplementation(() => {
      throw symlinkError("EACCES");
    });
    const workspace = join(tmpBase, "briefing-linux-error");
    mkdirSync(workspace, { recursive: true });

    expect(() => writeAgentBriefing(workspace, "briefing")).toThrow("symlink EACCES");
    expect(existsSync(join(workspace, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(workspace, "CLAUDE.md"))).toBe(false);
  });

  it("copies Claude skill payloads on Windows symlink EPERM", () => {
    setPlatform("win32");
    fsMocks.symlinkSync.mockImplementation(() => {
      throw symlinkError("EPERM");
    });
    const workspace = join(tmpBase, "skills-copy");
    mkdirSync(workspace, { recursive: true });
    const bundledSkillsRoot = makeFixtureSkillsRoot(tmpBase, "1.0.0", "v1");
    const logs: string[] = [];

    const result = installCoreSkills({
      workspacePath: workspace,
      bundledSkillsRoot,
      log: (message) => logs.push(message),
    });

    expect(result, logs.join("\n")).toBe(true);
    const claudeSkill = join(workspace, ".claude", "skills", "first-tree-seed");
    expect(lstatSync(claudeSkill).isDirectory()).toBe(true);
    expect(lstatSync(claudeSkill).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(claudeSkill, "SKILL.md"), "utf-8")).toContain("fixture v1 for first-tree-seed");
    expect(readFileSync(join(claudeSkill, "VERSION"), "utf-8")).toBe("1.0.0");
    expect(readFileSync(join(claudeSkill, "nested", "extra.txt"), "utf-8")).toBe("extra v1\n");
  });

  it("accepts a current Claude skill directory copy on the fast path", () => {
    setPlatform("win32");
    fsMocks.symlinkSync.mockImplementation(() => {
      throw symlinkError("EPERM");
    });
    const workspace = join(tmpBase, "skills-copy-fast-path");
    mkdirSync(workspace, { recursive: true });
    const bundledSkillsRoot = makeFixtureSkillsRoot(tmpBase, "1.0.0", "v1");
    installCoreSkills({ workspacePath: workspace, bundledSkillsRoot, log: () => {} });

    writeFileSync(join(workspace, ".agents", "skills", "first-tree-seed", ".sentinel"), "agents marker\n");
    writeFileSync(join(workspace, ".claude", "skills", "first-tree-seed", ".sentinel"), "claude marker\n");
    fsMocks.symlinkSync.mockClear();
    const logs: string[] = [];

    const result = installCoreSkills({
      workspacePath: workspace,
      bundledSkillsRoot,
      log: (message) => logs.push(message),
    });

    expect(result, logs.join("\n")).toBe(true);
    expect(fsMocks.symlinkSync).not.toHaveBeenCalled();
    expect(existsSync(join(workspace, ".agents", "skills", "first-tree-seed", ".sentinel"))).toBe(true);
    expect(existsSync(join(workspace, ".claude", "skills", "first-tree-seed", ".sentinel"))).toBe(true);
    expect(logs.join("\n")).toContain("up-to-date");
  });

  it("refreshes the Claude skill directory copy when the bundled payload drifts", () => {
    setPlatform("win32");
    fsMocks.symlinkSync.mockImplementation(() => {
      throw symlinkError("EPERM");
    });
    const workspace = join(tmpBase, "skills-copy-refresh");
    mkdirSync(workspace, { recursive: true });
    const bundledV1 = makeFixtureSkillsRoot(tmpBase, "1.0.0", "v1");
    installCoreSkills({ workspacePath: workspace, bundledSkillsRoot: bundledV1, log: () => {} });
    writeFileSync(join(workspace, ".claude", "skills", "first-tree-seed", ".sentinel"), "stale marker\n");

    const bundledV2 = makeFixtureSkillsRoot(tmpBase, "2.0.0", "v2");
    const logs: string[] = [];
    const result = installCoreSkills({
      workspacePath: workspace,
      bundledSkillsRoot: bundledV2,
      log: (message) => logs.push(message),
    });

    expect(result, logs.join("\n")).toBe(true);
    const claudeSkill = join(workspace, ".claude", "skills", "first-tree-seed");
    expect(readFileSync(join(claudeSkill, "SKILL.md"), "utf-8")).toContain("fixture v2 for first-tree-seed");
    expect(readFileSync(join(claudeSkill, "VERSION"), "utf-8")).toBe("2.0.0");
    expect(readFileSync(join(claudeSkill, "nested", "extra.txt"), "utf-8")).toBe("extra v2\n");
    expect(existsSync(join(claudeSkill, ".sentinel"))).toBe(false);
  });
});
