import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { generateCodeowners } from "../src/commands/tree/codeowners-lib.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function write(root: string, relPath: string, content: string): void {
  const full = join(root, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

afterEach(() => {
  vi.restoreAllMocks();

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("generateCodeowners — --always-include", () => {
  it("appends extra handles to every CODEOWNERS entry", () => {
    const root = makeTempDir("first-tree-codeowners-always-");
    write(root, "NODE.md", `---\ntitle: Context Tree\nowners: [alice]\n---\n\n# Context Tree\n`);
    write(root, "members/NODE.md", `---\ntitle: Members\nowners: [alice]\n---\n\n# Members\n`);
    write(
      root,
      "members/alice/NODE.md",
      `---\ntitle: Alice\nowners: [alice]\ntype: human\nrole: owner\ndomains: [core]\n---\n\n# Alice\n`,
    );
    write(root, "kael/NODE.md", `---\ntitle: Kael\nowners: [bob]\n---\n\n# Kael\n`);

    vi.spyOn(console, "log").mockImplementation(() => {});

    const exitCode = generateCodeowners(root, { alwaysInclude: ["first-tree-gate"] });

    expect(exitCode).toBe(0);

    const codeownersFile = join(root, ".github", "CODEOWNERS");
    expect(existsSync(codeownersFile)).toBe(true);
    const content = readFileSync(codeownersFile, "utf-8");

    const ownerLines = content.split("\n").filter((line) => line.startsWith("/") && line.trim().length > 0);

    expect(ownerLines.length).toBeGreaterThan(0);

    for (const line of ownerLines) {
      expect(line).toMatch(/@first-tree-gate(\s|$)/u);
    }
  });

  it("dedupes when an always-include handle is already an owner", () => {
    const root = makeTempDir("first-tree-codeowners-always-dedupe-");
    write(root, "NODE.md", `---\ntitle: Context Tree\nowners: [alice, first-tree-gate]\n---\n\n# Context Tree\n`);
    write(root, "members/NODE.md", `---\ntitle: Members\nowners: [alice]\n---\n\n# Members\n`);

    vi.spyOn(console, "log").mockImplementation(() => {});

    generateCodeowners(root, { alwaysInclude: ["@first-tree-gate"] });

    const content = readFileSync(join(root, ".github", "CODEOWNERS"), "utf-8");

    for (const line of content.split("\n").filter((l) => l.startsWith("/"))) {
      const matches = line.match(/@first-tree-gate(?=\s|$)/gu) ?? [];
      expect(matches.length).toBe(1);
    }
  });

  it("--check passes when CODEOWNERS matches the augmented output", () => {
    const root = makeTempDir("first-tree-codeowners-check-augmented-");
    write(root, "NODE.md", `---\ntitle: Context Tree\nowners: [alice]\n---\n\n# Context Tree\n`);
    write(root, "members/NODE.md", `---\ntitle: Members\nowners: [alice]\n---\n\n# Members\n`);

    vi.spyOn(console, "log").mockImplementation(() => {});

    const writeExit = generateCodeowners(root, { alwaysInclude: ["first-tree-gate"] });
    expect(writeExit).toBe(0);

    const checkExit = generateCodeowners(root, {
      check: true,
      alwaysInclude: ["first-tree-gate"],
    });
    expect(checkExit).toBe(0);
  });

  it("--check fails when CODEOWNERS lacks the always-include handles", () => {
    const root = makeTempDir("first-tree-codeowners-check-drift-");
    write(root, "NODE.md", `---\ntitle: Context Tree\nowners: [alice]\n---\n\n# Context Tree\n`);
    write(root, "members/NODE.md", `---\ntitle: Members\nowners: [alice]\n---\n\n# Members\n`);

    vi.spyOn(console, "log").mockImplementation(() => {});

    // Write CODEOWNERS WITHOUT --always-include.
    const writeExit = generateCodeowners(root);
    expect(writeExit).toBe(0);

    // Now check WITH --always-include — should report drift.
    const checkExit = generateCodeowners(root, {
      check: true,
      alwaysInclude: ["first-tree-gate"],
    });
    expect(checkExit).toBe(1);
  });
});
