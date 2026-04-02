import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Repo } from "#src/repo.js";
import { useTmpDir } from "./helpers.js";

// --- pathExists ---

describe("pathExists", () => {
  it("returns true for existing file", () => {
    const tmp = useTmpDir();
    writeFileSync(join(tmp.path, "file.txt"), "hello");
    const repo = new Repo(tmp.path);
    expect(repo.pathExists("file.txt")).toBe(true);
  });

  it("returns false for missing file", () => {
    const tmp = useTmpDir();
    const repo = new Repo(tmp.path);
    expect(repo.pathExists("no-such-file.txt")).toBe(false);
  });
});

// --- fileContains ---

describe("fileContains", () => {
  it("returns true when text is present", () => {
    const tmp = useTmpDir();
    writeFileSync(join(tmp.path, "f.md"), "hello world");
    const repo = new Repo(tmp.path);
    expect(repo.fileContains("f.md", "hello")).toBe(true);
  });

  it("returns false when text is missing", () => {
    const tmp = useTmpDir();
    writeFileSync(join(tmp.path, "f.md"), "hello world");
    const repo = new Repo(tmp.path);
    expect(repo.fileContains("f.md", "goodbye")).toBe(false);
  });

  it("returns false when file is missing", () => {
    const tmp = useTmpDir();
    const repo = new Repo(tmp.path);
    expect(repo.fileContains("missing.md", "anything")).toBe(false);
  });
});

// --- frontmatter ---

describe("frontmatter", () => {
  it("parses valid title and owners", () => {
    const tmp = useTmpDir();
    writeFileSync(
      join(tmp.path, "NODE.md"),
      "---\ntitle: My Tree\nowners: [alice, bob]\n---\n# Content\n",
    );
    const repo = new Repo(tmp.path);
    const fm = repo.frontmatter("NODE.md");
    expect(fm).not.toBeNull();
    expect(fm!.title).toBe("My Tree");
    expect(fm!.owners).toEqual(["alice", "bob"]);
  });

  it("returns null for missing frontmatter", () => {
    const tmp = useTmpDir();
    writeFileSync(
      join(tmp.path, "NODE.md"),
      "# Just a heading\nNo frontmatter here.\n",
    );
    const repo = new Repo(tmp.path);
    expect(repo.frontmatter("NODE.md")).toBeNull();
  });

  it("handles partial — title only", () => {
    const tmp = useTmpDir();
    writeFileSync(join(tmp.path, "NODE.md"), "---\ntitle: Partial\n---\n");
    const repo = new Repo(tmp.path);
    const fm = repo.frontmatter("NODE.md");
    expect(fm).not.toBeNull();
    expect(fm!.title).toBe("Partial");
    expect(fm!.owners).toBeUndefined();
  });

  it("handles partial — owners only", () => {
    const tmp = useTmpDir();
    writeFileSync(join(tmp.path, "NODE.md"), "---\nowners: [alice]\n---\n");
    const repo = new Repo(tmp.path);
    const fm = repo.frontmatter("NODE.md");
    expect(fm).not.toBeNull();
    expect(fm!.owners).toEqual(["alice"]);
    expect(fm!.title).toBeUndefined();
  });

  it("returns null for missing file", () => {
    const tmp = useTmpDir();
    const repo = new Repo(tmp.path);
    expect(repo.frontmatter("NODE.md")).toBeNull();
  });
});

// --- anyAgentConfig ---

describe("anyAgentConfig", () => {
  it("returns true with claude settings", () => {
    const tmp = useTmpDir();
    mkdirSync(join(tmp.path, ".claude"));
    writeFileSync(join(tmp.path, ".claude", "settings.json"), "{}");
    const repo = new Repo(tmp.path);
    expect(repo.anyAgentConfig()).toBe(true);
  });

  it("returns false without any config", () => {
    const tmp = useTmpDir();
    const repo = new Repo(tmp.path);
    expect(repo.anyAgentConfig()).toBe(false);
  });
});

// --- isGitRepo ---

describe("isGitRepo", () => {
  it("returns true with .git dir", () => {
    const tmp = useTmpDir();
    mkdirSync(join(tmp.path, ".git"));
    const repo = new Repo(tmp.path);
    expect(repo.isGitRepo()).toBe(true);
  });

  it("returns false without .git dir", () => {
    const tmp = useTmpDir();
    const repo = new Repo(tmp.path);
    expect(repo.isGitRepo()).toBe(false);
  });
});

// --- hasFramework ---

describe("hasFramework", () => {
  it("returns true with VERSION file", () => {
    const tmp = useTmpDir();
    mkdirSync(join(tmp.path, ".context-tree"));
    writeFileSync(join(tmp.path, ".context-tree", "VERSION"), "0.1.0\n");
    const repo = new Repo(tmp.path);
    expect(repo.hasFramework()).toBe(true);
  });

  it("returns false without VERSION file", () => {
    const tmp = useTmpDir();
    const repo = new Repo(tmp.path);
    expect(repo.hasFramework()).toBe(false);
  });
});

// --- readVersion ---

describe("readVersion", () => {
  it("reads valid version", () => {
    const tmp = useTmpDir();
    mkdirSync(join(tmp.path, ".context-tree"));
    writeFileSync(join(tmp.path, ".context-tree", "VERSION"), "0.2.0\n");
    const repo = new Repo(tmp.path);
    expect(repo.readVersion()).toBe("0.2.0");
  });

  it("returns null when missing", () => {
    const tmp = useTmpDir();
    const repo = new Repo(tmp.path);
    expect(repo.readVersion()).toBeNull();
  });
});

// --- hasAgentMdMarkers ---

describe("hasAgentMdMarkers", () => {
  it("returns true with markers", () => {
    const tmp = useTmpDir();
    writeFileSync(
      join(tmp.path, "AGENT.md"),
      "<!-- BEGIN CONTEXT-TREE FRAMEWORK -->\nstuff\n<!-- END CONTEXT-TREE FRAMEWORK -->\n",
    );
    const repo = new Repo(tmp.path);
    expect(repo.hasAgentMdMarkers()).toBe(true);
  });

  it("returns false without markers", () => {
    const tmp = useTmpDir();
    writeFileSync(
      join(tmp.path, "AGENT.md"),
      "# Agent instructions\nNo markers here.\n",
    );
    const repo = new Repo(tmp.path);
    expect(repo.hasAgentMdMarkers()).toBe(false);
  });

  it("returns false when file is missing", () => {
    const tmp = useTmpDir();
    const repo = new Repo(tmp.path);
    expect(repo.hasAgentMdMarkers()).toBe(false);
  });
});

// --- hasMembers ---

describe("hasMembers", () => {
  it("returns true with members/NODE.md", () => {
    const tmp = useTmpDir();
    const members = join(tmp.path, "members");
    mkdirSync(members);
    writeFileSync(join(members, "NODE.md"), "---\ntitle: Members\n---\n");
    const repo = new Repo(tmp.path);
    expect(repo.hasMembers()).toBe(true);
  });

  it("returns false without members dir", () => {
    const tmp = useTmpDir();
    const repo = new Repo(tmp.path);
    expect(repo.hasMembers()).toBe(false);
  });

  it("returns false with dir but no NODE.md", () => {
    const tmp = useTmpDir();
    mkdirSync(join(tmp.path, "members"));
    const repo = new Repo(tmp.path);
    expect(repo.hasMembers()).toBe(false);
  });
});

// --- memberCount ---

describe("memberCount", () => {
  it("returns 0 with no members dir", () => {
    const tmp = useTmpDir();
    const repo = new Repo(tmp.path);
    expect(repo.memberCount()).toBe(0);
  });

  it("counts one member", () => {
    const tmp = useTmpDir();
    const members = join(tmp.path, "members");
    mkdirSync(members);
    const alice = join(members, "alice");
    mkdirSync(alice);
    writeFileSync(join(alice, "NODE.md"), "---\ntitle: Alice\n---\n");
    const repo = new Repo(tmp.path);
    expect(repo.memberCount()).toBe(1);
  });

  it("counts two members", () => {
    const tmp = useTmpDir();
    const members = join(tmp.path, "members");
    mkdirSync(members);
    for (const name of ["alice", "bob"]) {
      const d = join(members, name);
      mkdirSync(d);
      writeFileSync(join(d, "NODE.md"), `---\ntitle: ${name}\n---\n`);
    }
    const repo = new Repo(tmp.path);
    expect(repo.memberCount()).toBe(2);
  });

  it("ignores dirs without NODE.md", () => {
    const tmp = useTmpDir();
    const members = join(tmp.path, "members");
    mkdirSync(members);
    mkdirSync(join(members, "alice")); // no NODE.md
    const bob = join(members, "bob");
    mkdirSync(bob);
    writeFileSync(join(bob, "NODE.md"), "---\ntitle: Bob\n---\n");
    const repo = new Repo(tmp.path);
    expect(repo.memberCount()).toBe(1);
  });
});

// --- hasPlaceholderNode ---

describe("hasPlaceholderNode", () => {
  it("returns true with placeholder", () => {
    const tmp = useTmpDir();
    writeFileSync(
      join(tmp.path, "NODE.md"),
      "---\ntitle: My Tree\n---\n<!-- PLACEHOLDER: fill in -->\n",
    );
    const repo = new Repo(tmp.path);
    expect(repo.hasPlaceholderNode()).toBe(true);
  });

  it("returns false without placeholder", () => {
    const tmp = useTmpDir();
    writeFileSync(
      join(tmp.path, "NODE.md"),
      "---\ntitle: My Tree\n---\n# Real content\n",
    );
    const repo = new Repo(tmp.path);
    expect(repo.hasPlaceholderNode()).toBe(false);
  });
});
