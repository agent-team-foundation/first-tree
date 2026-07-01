import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildScaffoldFiles, defaultRepoName, type ScaffoldFile } from "../commands/tree/init.js";
import { verifyTreeRoot } from "../commands/tree/verify.js";

/**
 * `first-tree tree init` scaffolds a brand-new team Context Tree repo with the
 * user's local `gh`. The load-bearing guarantee is that the seed it writes is a
 * *valid* tree — `tree verify` hard-fails on a `members/` dir with no member
 * nodes, so the minimal seed must carry the root node, the members index, and a
 * creator member node. These tests cover the pure builders; the gh/git/network
 * orchestration is exercised end-to-end, not unit-mocked.
 */

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ft-tree-init-"));
  tempDirs.push(dir);
  return dir;
}

function writeScaffold(dir: string, files: ScaffoldFile[]): void {
  for (const file of files) {
    const abs = join(dir, file.relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, file.content);
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("defaultRepoName", () => {
  it("slugifies the title and appends the -context-tree suffix", () => {
    expect(defaultRepoName("Acme Corp")).toBe("acme-corp-context-tree");
  });

  it("falls back to `team` when the title has no alphanumerics", () => {
    expect(defaultRepoName("！！！")).toBe("team-context-tree");
  });

  it("caps the whole name at GitHub's 100-char repo-name limit", () => {
    const name = defaultRepoName("a".repeat(200));
    expect(name.length).toBeLessThanOrEqual(100);
    expect(name.endsWith("-context-tree")).toBe(true);
  });
});

describe("buildScaffoldFiles", () => {
  it("produces a minimal tree that passes `tree verify`", () => {
    const dir = makeTempDir();
    writeScaffold(dir, buildScaffoldFiles({ title: "Acme", ownerLogin: "octocat", withWorkflow: false }));
    expect(verifyTreeRoot(dir).ok).toBe(true);
  });

  it("still passes verify with the validate-tree workflow seeded", () => {
    const dir = makeTempDir();
    writeScaffold(dir, buildScaffoldFiles({ title: "Acme", ownerLogin: "octocat", withWorkflow: true }));
    expect(verifyTreeRoot(dir).ok).toBe(true);
  });

  it("omits the validate-tree workflow by default (avoids the gh workflow scope)", () => {
    const files = buildScaffoldFiles({ title: "Acme", ownerLogin: "octocat", withWorkflow: false });
    expect(files.some((file) => file.relPath.includes("validate-tree.yml"))).toBe(false);
  });

  it("seeds a creator member node so member validation passes", () => {
    const files = buildScaffoldFiles({ title: "Acme", ownerLogin: "octocat", withWorkflow: false });
    expect(files.some((file) => file.relPath === join("members", "octocat", "NODE.md"))).toBe(true);
  });
});
