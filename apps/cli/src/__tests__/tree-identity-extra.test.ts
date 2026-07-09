import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeTreeState } from "../commands/tree/binding-state.js";
import {
  findUpwardsManagedTreeIdentity,
  readManagedTreeIdentity,
  readTreeIdentityContract,
  syncTreeIdentityFiles,
} from "../commands/tree/tree-identity.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ft-tree-identity-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("tree identity files", () => {
  it("skips roots with no supported identity file", () => {
    const root = makeTempDir();

    expect(syncTreeIdentityFiles(root, { treeRepoName: "tree" })).toBe("skipped");
    expect(readManagedTreeIdentity(root)).toBeUndefined();
    expect(findUpwardsManagedTreeIdentity(root)).toBeUndefined();
    expect(readTreeIdentityContract(root)).toBeUndefined();
  });

  it("inserts a managed block before project-specific instructions and reads it back", () => {
    const root = makeTempDir();
    const agentsPath = join(root, "AGENTS.md");
    writeFileSync(agentsPath, "Intro\r\n\r\n# Project-Specific Instructions\r\nKeep this section.\r\n", "utf8");

    expect(
      syncTreeIdentityFiles(root, {
        publishedTreeUrl: "https://github.com/acme/tree",
        treeMode: "dedicated",
        treeRepoName: "acme-tree",
      }),
    ).toBe("updated");

    const text = readFileSync(agentsPath, "utf8");
    expect(text).toContain("## Tree Identity");
    expect(text.indexOf("## Tree Identity")).toBeLessThan(text.indexOf("# Project-Specific Instructions"));
    expect(text).toContain("FIRST-TREE-TREE-MODE: `dedicated`");
    expect(text.endsWith("\n")).toBe(true);
    expect(readManagedTreeIdentity(root)).toMatchObject({
      file: "AGENTS.md",
      path: agentsPath,
      publishedTreeUrl: "https://github.com/acme/tree",
      treeMode: "dedicated",
      treeRepoName: "acme-tree",
    });
    mkdirSync(join(root, "a", "b"), { recursive: true });
    expect(findUpwardsManagedTreeIdentity(join(root, "a", "b"))).toMatchObject({ treeRepoName: "acme-tree" });
    expect(
      syncTreeIdentityFiles(root, {
        publishedTreeUrl: "https://github.com/acme/tree",
        treeMode: "dedicated",
        treeRepoName: "acme-tree",
      }),
    ).toBe("unchanged");
  });

  it("inserts after the Context Tree framework marker and handles pending publish", () => {
    const root = makeTempDir();
    const claudePath = join(root, "CLAUDE.md");
    writeFileSync(claudePath, "Framework\n<!-- END CONTEXT-TREE FRAMEWORK -->\n\nExisting tail\n", "utf8");

    expect(syncTreeIdentityFiles(root, { treeMode: "shared", treeRepoName: "shared-tree" })).toBe("updated");

    const text = readFileSync(claudePath, "utf8");
    expect(text.indexOf("## Tree Identity")).toBeGreaterThan(text.indexOf("END CONTEXT-TREE FRAMEWORK"));
    expect(text).toContain("FIRST-TREE-TREE-PUBLISHED-URL: pending publish");
    const parsed = readManagedTreeIdentity(root);
    expect(parsed).toMatchObject({
      file: "CLAUDE.md",
      treeMode: "shared",
      treeRepoName: "shared-tree",
    });
    expect(parsed).not.toHaveProperty("publishedTreeUrl");
  });

  it("appends to ordinary files and replaces an existing managed block", () => {
    const root = makeTempDir();
    const agentsPath = join(root, "AGENTS.md");
    writeFileSync(agentsPath, "Plain instructions\n", "utf8");

    expect(syncTreeIdentityFiles(root, { treeRepoName: "first-tree" })).toBe("updated");
    expect(readFileSync(agentsPath, "utf8")).toContain("FIRST-TREE-TREE-REPO: `first-tree`");

    expect(
      syncTreeIdentityFiles(root, {
        publishedTreeUrl: "https://github.com/acme/next-tree",
        treeMode: "dedicated",
        treeRepoName: "next-tree",
      }),
    ).toBe("updated");

    const text = readFileSync(agentsPath, "utf8");
    expect(text).toContain("FIRST-TREE-TREE-REPO: `next-tree`");
    expect(text).not.toContain("FIRST-TREE-TREE-REPO: `first-tree`");
    expect(readManagedTreeIdentity(root)).toMatchObject({
      publishedTreeUrl: "https://github.com/acme/next-tree",
      treeMode: "dedicated",
      treeRepoName: "next-tree",
    });
  });

  it("ignores malformed managed blocks and invalid tree modes", () => {
    const root = makeTempDir();
    writeFileSync(
      join(root, "AGENTS.md"),
      [
        "<!-- BEGIN FIRST-TREE-TREE-IDENTITY -->",
        "<!--",
        "FIRST-TREE-TREE-IDENTITY: managed-block-v1",
        "FIRST-TREE-TREE-MODE: `invalid`",
        "FIRST-TREE-TREE-PUBLISHED-URL: `https://github.com/acme/tree`",
        "-->",
        "<!-- END FIRST-TREE-TREE-IDENTITY -->",
      ].join("\n"),
      "utf8",
    );
    expect(readManagedTreeIdentity(root)).toBeUndefined();

    writeFileSync(
      join(root, "AGENTS.md"),
      [
        "<!-- BEGIN FIRST-TREE-TREE-IDENTITY -->",
        "<!--",
        "FIRST-TREE-TREE-IDENTITY: managed-block-v1",
        "FIRST-TREE-TREE-REPO: acme-tree",
        "FIRST-TREE-TREE-MODE: invalid",
        "FIRST-TREE-TREE-PUBLISHED-URL: https://github.com/acme/tree",
        "-->",
        "<!-- END FIRST-TREE-TREE-IDENTITY -->",
      ].join("\n"),
      "utf8",
    );
    expect(readManagedTreeIdentity(root)).toMatchObject({
      publishedTreeUrl: "https://github.com/acme/tree",
      treeMode: undefined,
      treeRepoName: "acme-tree",
    });
  });

  it("prefers a managed identity over tree state but falls back to tree state when absent", () => {
    const root = makeTempDir();
    writeTreeState(root, {
      published: { remoteUrl: "https://github.com/acme/state-tree" },
      treeId: "tree_1",
      treeMode: "shared",
      treeRepoName: "state-tree",
    });

    expect(readTreeIdentityContract(root)).toEqual({
      publishedTreeUrl: "https://github.com/acme/state-tree",
      treeMode: "shared",
      treeRepoName: "state-tree",
    });

    writeFileSync(join(root, "AGENTS.md"), "Instructions\n", "utf8");
    syncTreeIdentityFiles(root, {
      publishedTreeUrl: "https://github.com/acme/managed-tree",
      treeMode: "dedicated",
      treeRepoName: "managed-tree",
    });

    expect(readTreeIdentityContract(root)).toMatchObject({
      publishedTreeUrl: "https://github.com/acme/managed-tree",
      treeMode: "dedicated",
      treeRepoName: "managed-tree",
    });
  });
});
