import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildScaffoldFiles, defaultRepoName, resolveRepoOwner, type ScaffoldFile } from "../commands/tree/init.js";
import {
  memberNodeContent,
  membersIndexContent,
  rootNodeContent,
  validateTreeWorkflowContent,
} from "../commands/tree/scaffold-templates.js";
import { renderContextTree } from "../commands/tree/tree.js";
import { verifyCommand, verifyTreeRoot } from "../commands/tree/verify.js";
import type { CommandContext } from "../commands/types.js";

/**
 * `first-tree tree init` scaffolds a brand-new team Context Tree repo with the
 * user's local `gh`. The load-bearing guarantee is that the seed it writes is a
 * *valid* tree — `tree verify` hard-fails on a `members/` dir with no member
 * nodes, so the minimal seed must carry the root node, the members index, and a
 * creator member node. These tests cover the pure builders; the gh/git/network
 * orchestration is exercised end-to-end, not unit-mocked.
 */

const tempDirs: string[] = [];
const originalCwd = process.cwd();

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
  vi.restoreAllMocks();
  process.chdir(originalCwd);
  process.exitCode = undefined;
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
    expect(readFileSync(join(dir, "NODE.md"), "utf-8")).not.toContain("validationPolicyVersion");
    expect(verifyTreeRoot(dir)).toMatchObject({ findings: [], ok: true });
  });

  it("reports root NODE frontmatter problems", () => {
    const missingFrontmatter = makeTempDir();
    writeFileSync(join(missingFrontmatter, "NODE.md"), "# Root\n");
    mkdirSync(join(missingFrontmatter, "members"), { recursive: true });
    const missingFrontmatterResult = verifyTreeRoot(missingFrontmatter);
    expect(missingFrontmatterResult.ok).toBe(false);
    expect(missingFrontmatterResult.checks.rootNodeFrontmatter.errors).toContain(
      "Root NODE.md is missing frontmatter.",
    );

    const missingTitle = makeTempDir();
    writeFileSync(join(missingTitle, "NODE.md"), "---\nowners: [octocat]\n---\n# Root\n");
    mkdirSync(join(missingTitle, "members"), { recursive: true });
    const missingTitleResult = verifyTreeRoot(missingTitle);
    expect(missingTitleResult.ok).toBe(false);
    expect(missingTitleResult.checks.rootNodeFrontmatter.errors).toContain("Root NODE.md is missing a title.");
  });

  it("reports missing root frontmatter when NODE.md cannot be read as a file", () => {
    const unreadableRootNode = makeTempDir();
    mkdirSync(join(unreadableRootNode, "NODE.md"), { recursive: true });
    mkdirSync(join(unreadableRootNode, "members"), { recursive: true });

    const result = verifyTreeRoot(unreadableRootNode);

    expect(result.ok).toBe(false);
    expect(result.checks.rootNodeFrontmatter.errors).toContain("Root NODE.md is missing frontmatter.");
  });

  it("uses the current repo root when tree verify omits --tree-path", () => {
    const dir = makeTempDir();
    writeScaffold(dir, buildScaffoldFiles({ title: "Acme", ownerLogin: "octocat", withWorkflow: false }));
    mkdirSync(join(dir, ".git"));
    process.chdir(dir);
    const command = new Command("verify");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    verifyCommand.action({
      command,
      options: { debug: false, json: false, quiet: false },
    } satisfies CommandContext);

    expect(process.exitCode).toBeUndefined();
    expect(log.mock.calls.map((call) => String(call[0])).join("\n")).toContain("All checks passed.");
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

  it("renders the members domain and creator in `tree tree` (needs non-empty owners)", () => {
    // `tree tree` skips directory nodes with empty owners, so a scaffold that
    // passes `verify` could still be invisible to the hierarchy browser. Assert
    // the members domain and the creator member actually render.
    const dir = makeTempDir();
    writeScaffold(dir, buildScaffoldFiles({ title: "Acme", ownerLogin: "octocat", withWorkflow: false }));
    const rendered = renderContextTree(dir);
    expect(rendered).toContain("members/");
    expect(rendered).toContain("members/octocat/");
  });
});

describe("resolveRepoOwner", () => {
  it("defaults to the installation account in the bound path so the repo is coverable", () => {
    // The App installation is on the org; the repo must live under the org, not
    // the admin's personal account, or the installation can never cover it.
    expect(resolveRepoOwner({ creatorLogin: "octocat", installationAccount: "acme-org" })).toBe("acme-org");
  });

  it("accepts an explicit --owner that matches the installation account", () => {
    expect(
      resolveRepoOwner({ optionOwner: "acme-org", creatorLogin: "octocat", installationAccount: "acme-org" }),
    ).toBe("acme-org");
  });

  it("rejects an explicit --owner that does not match the installation account", () => {
    expect(() =>
      resolveRepoOwner({ optionOwner: "octocat", creatorLogin: "octocat", installationAccount: "acme-org" }),
    ).toThrow(/does not match/u);
  });

  it("falls back to the gh user when there is no installation to match (no-bind / no-installation)", () => {
    expect(resolveRepoOwner({ creatorLogin: "octocat", installationAccount: null })).toBe("octocat");
    expect(resolveRepoOwner({ optionOwner: "someone", creatorLogin: "octocat", installationAccount: null })).toBe(
      "someone",
    );
  });

  it("matches --owner case-insensitively and returns the canonical casing", () => {
    // GitHub account names are case-insensitive, so `--owner ACME-Org` must not
    // be rejected against a stored `acme-org`; the canonical casing is returned.
    expect(
      resolveRepoOwner({ optionOwner: "ACME-Org", creatorLogin: "octocat", installationAccount: "acme-org" }),
    ).toBe("acme-org");
  });
});

describe("scaffold-templates (ejs)", () => {
  it("renders the root node with quoted frontmatter and the owner", () => {
    const node = rootNodeContent("Acme", "octocat");
    expect(node).toContain('title: "Acme Context Tree"');
    expect(node).toContain("owners: [octocat]");
    expect(node).toContain("# Acme's Context Tree");
  });

  it("renders the members index with a non-empty owner", () => {
    expect(membersIndexContent("octocat")).toContain("owners: [octocat]");
  });

  it("renders a member node carrying the required member fields", () => {
    const node = memberNodeContent("octocat");
    expect(node).toContain('title: "octocat"');
    expect(node).toContain("owners: [octocat]");
    expect(node).toContain("type: human");
  });

  it("renders the validate-tree workflow", () => {
    expect(validateTreeWorkflowContent()).toContain("first-tree tree verify");
  });

  it("preserves a valid branch exactly in the validate-tree workflow", () => {
    const branch = "feature\u00a0context-tree";
    expect(validateTreeWorkflowContent(branch)).toContain(`branches: ['${branch}']`);
  });

  it("escapes GitHub branch-pattern operators after validating the branch", () => {
    expect(validateTreeWorkflowContent("release!+candidate")).toContain("branches: ['release\\!\\+candidate']");
    expect(() => validateTreeWorkflowContent("release\\candidate")).toThrow();
  });
});
