import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runValidateNodes } from "../src/commands/tree/validate-nodes.js";

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

const ROOT_FRONTMATTER = `---\ntitle: Root\nowners: [alice]\n---\n\n# Root\n`;

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("runValidateNodes — non-personal files", () => {
  it("flags missing frontmatter on non-personal nodes", () => {
    const root = makeTempDir("validate-nodes-");
    write(root, "NODE.md", ROOT_FRONTMATTER);
    write(root, "domain/NODE.md", "# domain\n");

    const result = runValidateNodes(root);

    expect(result.exitCode).toBe(1);
    expect(result.errors).toContain("domain/NODE.md: missing frontmatter");
  });

  it("flags missing title and owners fields on non-personal nodes", () => {
    const root = makeTempDir("validate-nodes-");
    write(root, "NODE.md", ROOT_FRONTMATTER);
    write(root, "domain/leaf.md", "---\nfoo: bar\n---\n\n# leaf\n");

    const result = runValidateNodes(root);

    expect(result.exitCode).toBe(1);
    expect(result.errors).toContain("domain/leaf.md: missing 'title' field in frontmatter");
    expect(result.errors).toContain("domain/leaf.md: missing 'owners' field in frontmatter");
  });

  it("treats members/NODE.md as non-personal (members domain root)", () => {
    const root = makeTempDir("validate-nodes-");
    write(root, "NODE.md", ROOT_FRONTMATTER);
    write(root, "members/NODE.md", "# members\n");

    const result = runValidateNodes(root);

    expect(result.exitCode).toBe(1);
    expect(result.errors).toContain("members/NODE.md: missing frontmatter");
  });

  it("skips generated and managed framework paths while continuing past symlinks", (ctx) => {
    const root = makeTempDir("validate-nodes-");
    write(root, "NODE.md", ROOT_FRONTMATTER);
    write(root, ".agents/skills/hidden.md", "# ignored\n");
    write(root, "node_modules/pkg/ignored.md", "# ignored\n");
    write(root, "AGENTS.md", "# ignored\n");
    const managedTarget = join(root, "target-whitepaper.md");
    writeFileSync(managedTarget, "---\ntitle: Target\nowners: [alice]\n---\n");
    try {
      symlinkSync(managedTarget, join(root, "WHITEPAPER.md"));
    } catch {
      ctx.skip("Symlink creation is not supported in this environment.");
    }

    const result = runValidateNodes(root);

    expect(result).toEqual({ exitCode: 0, errors: [] });
  });

  it("ignores directories that cannot be read while collecting markdown files", () => {
    const root = makeTempDir("validate-nodes-");
    write(root, "NODE.md", ROOT_FRONTMATTER);
    const unreadable = join(root, "unreadable");
    mkdirSync(unreadable, { recursive: true });
    chmodSync(unreadable, 0o300);

    try {
      const result = runValidateNodes(root);
      expect(result).toEqual({ exitCode: 0, errors: [] });
    } finally {
      chmodSync(unreadable, 0o700);
    }
  });

  it("rejects dangling Markdown symlinks", (ctx) => {
    const root = makeTempDir("validate-nodes-");
    write(root, "NODE.md", ROOT_FRONTMATTER);
    try {
      symlinkSync(join(root, "missing.md"), join(root, "broken.md"));
    } catch {
      ctx.skip("Symlink creation is not supported in this environment.");
    }

    const result = runValidateNodes(root);

    expect(result).toEqual({
      exitCode: 1,
      errors: ["[TREE_MARKDOWN_FILE_SYMLINK_BROKEN] broken.md: Markdown file symlink target cannot be resolved"],
    });
  });
});

describe("runValidateNodes — personal-path relaxation", () => {
  it("allows personal files with no frontmatter (plain markdown)", () => {
    const root = makeTempDir("validate-nodes-");
    write(root, "NODE.md", ROOT_FRONTMATTER);
    write(root, "members/alice/NODE.md", "---\ntitle: Alice\nowners: [alice]\n---\n");
    write(root, "members/alice/notebook.md", "# raw notes — no frontmatter\n");

    const result = runValidateNodes(root);

    expect(result.exitCode).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it("allows personal files with partial frontmatter (no title, no owners)", () => {
    const root = makeTempDir("validate-nodes-");
    write(root, "NODE.md", ROOT_FRONTMATTER);
    write(root, "members/alice/NODE.md", "---\ntitle: Alice\nowners: [alice]\n---\n");
    write(root, "members/alice/draft.md", "---\ntags: [todo]\n---\n# draft\n");

    const result = runValidateNodes(root);

    expect(result.exitCode).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it("still validates soft_links inside personal files when present", () => {
    const root = makeTempDir("validate-nodes-");
    write(root, "NODE.md", ROOT_FRONTMATTER);
    write(root, "members/alice/NODE.md", "---\ntitle: Alice\nowners: [alice]\n---\n");
    write(root, "members/alice/notes.md", "---\nsoft_links:\n  - /does/not/exist.md\n---\n# notes\n");

    const result = runValidateNodes(root);

    expect(result.exitCode).toBe(1);
    expect(result.errors).toContain("members/alice/notes.md: broken soft_links target '/does/not/exist.md'");
  });

  it("accepts inline soft_links pointing at markdown files or node directories", () => {
    const root = makeTempDir("validate-nodes-");
    write(root, "NODE.md", ROOT_FRONTMATTER);
    write(root, "domain/NODE.md", "---\ntitle: Domain\nowners: [alice]\n---\n");
    write(root, "domain/reference.md", "---\ntitle: Reference\nowners: [alice]\n---\n");
    write(root, "members/alice/links.md", "---\nsoft_links: [domain, /domain/reference.md]\n---\n# links\n");

    const result = runValidateNodes(root);

    expect(result).toEqual({ exitCode: 0, errors: [] });
  });

  it("relaxes nested personal subtrees too (members/<me>/sub/path.md)", () => {
    const root = makeTempDir("validate-nodes-");
    write(root, "NODE.md", ROOT_FRONTMATTER);
    write(root, "members/alice/NODE.md", "---\ntitle: Alice\nowners: [alice]\n---\n");
    write(root, "members/alice/projects/q3-plan.md", "# Q3\n");
    write(root, "members/alice/assistant/NODE.md", "# alice-assistant — no frontmatter\n");

    const result = runValidateNodes(root);

    expect(result.exitCode).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it("relaxes members/<me>/NODE.md itself (validate-members enforces member schema separately)", () => {
    // `members/<me>/NODE.md` is on a personal path, so this validator
    // does not require frontmatter / title / owners. The full member
    // schema (title, owners, type, role, domains) is enforced by
    // `validate-members` in the same `tree verify` run, so member
    // NODE.md files remain strict overall — this test guards against
    // a future change that would double-fail them here.
    const root = makeTempDir("validate-nodes-");
    write(root, "NODE.md", ROOT_FRONTMATTER);
    write(root, "members/alice/NODE.md", "# alice — schema lives in validate-members\n");

    const result = runValidateNodes(root);

    expect(result.exitCode).toBe(0);
    expect(result.errors).toEqual([]);
  });
});
