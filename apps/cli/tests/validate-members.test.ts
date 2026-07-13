import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runValidateMembers } from "../src/commands/tree/validate-members.js";

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

function mkdir(root: string, relPath: string): void {
  mkdirSync(join(root, relPath), { recursive: true });
}

const VALID_MEMBER_FRONTMATTER = (name: string): string =>
  `---\ntitle: "${name}"\nowners: [${name}]\ntype: human\nrole: "Engineer"\ndomains:\n  - "system design"\n---\n\n## About\n`;

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("runValidateMembers — top-level requirements", () => {
  it("flags a top-level member directory missing NODE.md", () => {
    const root = makeTempDir("validate-members-");
    mkdir(root, "members/alice");

    const result = runValidateMembers(root);

    expect(result.exitCode).toBe(1);
    expect(result.errors).toContain("members/alice/: directory exists but missing NODE.md");
  });

  it("accepts a valid top-level member node", () => {
    const root = makeTempDir("validate-members-");
    write(root, "members/alice/NODE.md", VALID_MEMBER_FRONTMATTER("alice"));

    const result = runValidateMembers(root);

    expect(result.exitCode).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it("reports every required member frontmatter field and enum violation", () => {
    const root = makeTempDir("validate-members-");
    write(root, "members/no-frontmatter/NODE.md", "# no metadata\n");
    write(root, "members/broken/NODE.md", `---\nowners: []\ntype: robot\nstatus: active\ndomains: []\n---\n`);
    write(
      root,
      "members/missing-owners/NODE.md",
      `---\ntitle: Missing Owners\ntype: human\nrole: Engineer\ndomains: [system design]\n---\n`,
    );

    const result = runValidateMembers(root);

    expect(result.exitCode).toBe(1);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        "members/no-frontmatter/NODE.md: no frontmatter found",
        "members/broken/NODE.md: missing or empty 'title' field",
        "members/broken/NODE.md: invalid type 'robot' — must be one of: agent, human",
        "members/broken/NODE.md: invalid status 'active' — must be one of: invited",
        "members/broken/NODE.md: missing or empty 'role' field",
        "members/broken/NODE.md: 'domains' must contain at least one entry",
        "members/missing-owners/NODE.md: missing 'owners' field",
      ]),
    );
  });

  it("ignores member entries that disappear before stat", (ctx) => {
    const root = makeTempDir("validate-members-");
    mkdir(root, "members");
    try {
      symlinkSync(join(root, "missing"), join(root, "members", "broken-link"));
    } catch {
      ctx.skip("Symlink creation is not supported in this environment.");
    }

    const result = runValidateMembers(root);

    expect(result.exitCode).toBe(1);
    expect(result.errors).toContain("members/: no member nodes were found");
  });

  it("accepts block-list owners and quoted inline domains", () => {
    const root = makeTempDir("validate-members-");
    write(
      root,
      "members/alice/NODE.md",
      `---\ntitle: "alice"\nowners:\n  - "alice"\ntype: human\nrole: Engineer\ndomains: ["system design"]\n---\n`,
    );

    const result = runValidateMembers(root);

    expect(result).toEqual({ exitCode: 0, errors: [] });
  });
});

describe("runValidateMembers — nested directories under a member node", () => {
  it("validates a nested member node when NODE.md is present (assistant pattern)", () => {
    const root = makeTempDir("validate-members-");
    write(root, "members/alice/NODE.md", VALID_MEMBER_FRONTMATTER("alice"));
    write(
      root,
      "members/alice/alice-assistant/NODE.md",
      `---\ntitle: "alice-assistant"\nowners: [alice]\ntype: agent\nrole: "Assistant"\ndomains:\n  - "delegate"\n---\n`,
    );

    const result = runValidateMembers(root);

    expect(result.exitCode).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it("allows nested directories without NODE.md (research/notes/attachments)", () => {
    const root = makeTempDir("validate-members-");
    write(root, "members/alice/NODE.md", VALID_MEMBER_FRONTMATTER("alice"));
    mkdir(root, "members/alice/research");
    write(root, "members/alice/research/2026-05-09-some-note.md", "# note\n");
    mkdir(root, "members/alice/attachments");
    write(root, "members/alice/attachments/diagram.svg", "<svg/>");

    const result = runValidateMembers(root);

    expect(result.exitCode).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it("does not recurse into non-node nested directories looking for further members", () => {
    const root = makeTempDir("validate-members-");
    write(root, "members/alice/NODE.md", VALID_MEMBER_FRONTMATTER("alice"));
    // A deeply-nested directory under research/ should not be required to
    // hold a NODE.md just because the walker entered it.
    mkdir(root, "members/alice/research/2026-05/sub-topic");

    const result = runValidateMembers(root);

    expect(result.exitCode).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it("still validates frontmatter of a nested member node when present", () => {
    const root = makeTempDir("validate-members-");
    write(root, "members/alice/NODE.md", VALID_MEMBER_FRONTMATTER("alice"));
    // Nested NODE.md is missing required `domains` — should be flagged.
    write(
      root,
      "members/alice/alice-assistant/NODE.md",
      `---\ntitle: "alice-assistant"\nowners: [alice]\ntype: agent\nrole: "Assistant"\n---\n`,
    );

    const result = runValidateMembers(root);

    expect(result.exitCode).toBe(1);
    expect(result.errors.some((message) => message.includes("missing 'domains' field"))).toBe(true);
  });

  it("does not follow directory symlink loops in personal member subtrees", (ctx) => {
    const root = makeTempDir("validate-members-");
    write(root, "members/alice/NODE.md", VALID_MEMBER_FRONTMATTER("alice"));
    try {
      symlinkSync("..", join(root, "members", "alice", "loop"), "dir");
    } catch {
      ctx.skip("Symlink creation is not supported in this environment.");
    }

    expect(runValidateMembers(root)).toEqual({ exitCode: 0, errors: [] });
  });
});

describe("runValidateMembers — missing members directory", () => {
  it("flags a tree without a members directory at all", () => {
    const root = makeTempDir("validate-members-");
    write(root, "NODE.md", `---\ntitle: Root\nowners: [root]\n---\n`);

    const result = runValidateMembers(root);

    expect(result.exitCode).toBe(1);
    expect(result.errors[0]).toMatch(/Members directory not found/u);
  });

  it("flags a members directory with zero member nodes", () => {
    const root = makeTempDir("validate-members-");
    mkdir(root, "members");

    const result = runValidateMembers(root);

    expect(result.exitCode).toBe(1);
    expect(result.errors).toContain("members/: no member nodes were found");
  });
});
