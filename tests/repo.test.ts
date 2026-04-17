import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  countProjectSpecificPlaceholderBlocks,
  Repo,
} from "#products/tree/engine/repo.js";
import {
  AGENT_INSTRUCTIONS_FILE,
  CLAUDE_INSTALLED_PROGRESS,
  CLAUDE_INSTRUCTIONS_FILE,
  FRAMEWORK_VERSION,
  INSTALLED_PROGRESS,
  LEGACY_AGENT_INSTRUCTIONS_FILE,
  LEGACY_REPO_SKILL_PROGRESS,
  LEGACY_REPO_SKILL_VERSION,
  LEGACY_PROGRESS,
  LEGACY_VERSION,
  SOURCE_INTEGRATION_MARKER,
  TREE_PROGRESS,
  TREE_VERSION,
} from "#products/tree/engine/runtime/asset-loader.js";
import {
  useTmpDir,
  makeFramework,
  makeClaudeMd,
  makeGitRepo,
  makeLegacyFramework,
  makeLegacyRepoFramework,
  makeSourceRepo,
  makeSourceSkill,
  makeTreeMetadata,
} from "./helpers.js";

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

// --- project-specific placeholder detection ---

describe("countProjectSpecificPlaceholderBlocks", () => {
  it("counts duplicate placeholder blocks after the framework marker", () => {
    const text = [
      "<!-- BEGIN CONTEXT-TREE FRAMEWORK -->",
      "framework stuff",
      "<!-- END CONTEXT-TREE FRAMEWORK -->",
      "",
      "# Project-Specific Instructions",
      "",
      "<!-- Add your project-specific agent instructions below this line. -->",
      "",
      "# Project-Specific Instructions",
      "",
      "<!-- Add your project-specific agent instructions below this line. -->",
      "",
    ].join("\n");

    expect(countProjectSpecificPlaceholderBlocks(text)).toBe(2);
  });

  it("ignores placeholder text before the framework marker", () => {
    const text = [
      "# Project-Specific Instructions",
      "",
      "<!-- Add your project-specific agent instructions below this line. -->",
      "",
      "<!-- BEGIN CONTEXT-TREE FRAMEWORK -->",
      "framework stuff",
      "<!-- END CONTEXT-TREE FRAMEWORK -->",
      "",
      "# Project-Specific Instructions",
      "",
      "<!-- Add your project-specific agent instructions below this line. -->",
      "",
    ].join("\n");

    expect(countProjectSpecificPlaceholderBlocks(text)).toBe(1);
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

  it("returns true with codex hooks", () => {
    const tmp = useTmpDir();
    mkdirSync(join(tmp.path, ".codex"), { recursive: true });
    writeFileSync(join(tmp.path, ".codex", "hooks.json"), "{}");
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
    makeGitRepo(tmp.path);
    const repo = new Repo(tmp.path);
    expect(repo.isGitRepo()).toBe(true);
  });

  it("returns true with .git file", () => {
    const tmp = useTmpDir();
    writeFileSync(join(tmp.path, ".git"), "gitdir: /tmp/example\n");
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
  it("returns true with installed skill version file", () => {
    const tmp = useTmpDir();
    makeFramework(tmp.path);
    const repo = new Repo(tmp.path);
    expect(repo.hasFramework()).toBe(true);
  });

  it("returns true with legacy version file", () => {
    const tmp = useTmpDir();
    makeLegacyFramework(tmp.path);
    const repo = new Repo(tmp.path);
    expect(repo.hasFramework()).toBe(true);
  });

  it("returns true with dedicated tree metadata", () => {
    const tmp = useTmpDir();
    makeTreeMetadata(tmp.path);
    const repo = new Repo(tmp.path);
    expect(repo.hasFramework()).toBe(true);
  });

  it("returns true with the previous workspace skill path", () => {
    const tmp = useTmpDir();
    makeLegacyRepoFramework(tmp.path);
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
  it("reads the installed skill version", () => {
    const tmp = useTmpDir();
    makeFramework(tmp.path, "0.2.0");
    const repo = new Repo(tmp.path);
    expect(repo.readVersion()).toBe("0.2.0");
  });

  it("falls back to the legacy version", () => {
    const tmp = useTmpDir();
    makeLegacyFramework(tmp.path, "0.3.0");
    const repo = new Repo(tmp.path);
    expect(repo.readVersion()).toBe("0.3.0");
  });

  it("reads the dedicated tree metadata version", () => {
    const tmp = useTmpDir();
    makeTreeMetadata(tmp.path, "0.2.5");
    const repo = new Repo(tmp.path);
    expect(repo.readVersion()).toBe("0.2.5");
  });

  it("reads the previous workspace skill version", () => {
    const tmp = useTmpDir();
    makeLegacyRepoFramework(tmp.path, "0.2.4");
    const repo = new Repo(tmp.path);
    expect(repo.readVersion()).toBe("0.2.4");
  });

  it("returns null when missing", () => {
    const tmp = useTmpDir();
    const repo = new Repo(tmp.path);
    expect(repo.readVersion()).toBeNull();
  });
});

// --- preferredProgressPath / frameworkVersionPath ---

describe("path preferences", () => {
  it("prefers the installed-skill paths by default", () => {
    const tmp = useTmpDir();
    const repo = new Repo(tmp.path);
    expect(repo.preferredProgressPath()).toBe(INSTALLED_PROGRESS);
    expect(repo.frameworkVersionPath()).toBe(FRAMEWORK_VERSION);
  });

  it("switches path preferences for legacy repos", () => {
    const tmp = useTmpDir();
    makeLegacyFramework(tmp.path);
    const repo = new Repo(tmp.path);
    expect(repo.preferredProgressPath()).toBe(LEGACY_PROGRESS);
    expect(repo.frameworkVersionPath()).toBe(LEGACY_VERSION);
  });

  it("switches path preferences for dedicated tree metadata", () => {
    const tmp = useTmpDir();
    makeTreeMetadata(tmp.path);
    const repo = new Repo(tmp.path);
    expect(repo.preferredProgressPath()).toBe(TREE_PROGRESS);
    expect(repo.frameworkVersionPath()).toBe(TREE_VERSION);
  });

  it("keeps preferring dedicated tree metadata even when the tree repo also has an installed skill", () => {
    const tmp = useTmpDir();
    makeTreeMetadata(tmp.path);
    makeFramework(tmp.path);
    const repo = new Repo(tmp.path);
    expect(repo.frameworkLayout()).toBe("tree");
    expect(repo.preferredProgressPath()).toBe(TREE_PROGRESS);
    expect(repo.frameworkVersionPath()).toBe(TREE_VERSION);
  });

  it("switches path preferences for repos using the previous workspace skill path", () => {
    const tmp = useTmpDir();
    makeLegacyRepoFramework(tmp.path);
    const repo = new Repo(tmp.path);
    expect(repo.preferredProgressPath()).toBe(LEGACY_REPO_SKILL_PROGRESS);
    expect(repo.frameworkVersionPath()).toBe(LEGACY_REPO_SKILL_VERSION);
  });
});

// --- agent instructions helpers ---

describe("agent instructions helpers", () => {
  it("prefers AGENTS.md when both filenames exist", () => {
    const tmp = useTmpDir();
    writeFileSync(
      join(tmp.path, AGENT_INSTRUCTIONS_FILE),
      "<!-- BEGIN CONTEXT-TREE FRAMEWORK -->\nstuff\n<!-- END CONTEXT-TREE FRAMEWORK -->\n",
    );
    writeFileSync(
      join(tmp.path, LEGACY_AGENT_INSTRUCTIONS_FILE),
      "# Legacy instructions\n",
    );
    makeClaudeMd(tmp.path, { markers: true, userContent: true });
    const repo = new Repo(tmp.path);
    expect(repo.agentInstructionsPath()).toBe(AGENT_INSTRUCTIONS_FILE);
    expect(repo.hasCanonicalAgentInstructionsFile()).toBe(true);
    expect(repo.hasLegacyAgentInstructionsFile()).toBe(true);
    expect(repo.hasDuplicateAgentInstructionsFiles()).toBe(true);
    expect(repo.hasAgentInstructionsMarkers()).toBe(true);
    expect(repo.hasClaudeInstructionsMarkers()).toBe(true);
  });

  it("falls back to legacy AGENT.md while migrating", () => {
    const tmp = useTmpDir();
    writeFileSync(
      join(tmp.path, LEGACY_AGENT_INSTRUCTIONS_FILE),
      "<!-- BEGIN CONTEXT-TREE FRAMEWORK -->\nstuff\n<!-- END CONTEXT-TREE FRAMEWORK -->\n",
    );
    const repo = new Repo(tmp.path);
    expect(repo.agentInstructionsPath()).toBe(LEGACY_AGENT_INSTRUCTIONS_FILE);
    expect(repo.hasCanonicalAgentInstructionsFile()).toBe(false);
    expect(repo.hasLegacyAgentInstructionsFile()).toBe(true);
    expect(repo.hasDuplicateAgentInstructionsFiles()).toBe(false);
    expect(repo.hasAgentInstructionsMarkers()).toBe(true);
  });

  it("returns false without markers", () => {
    const tmp = useTmpDir();
    writeFileSync(
      join(tmp.path, AGENT_INSTRUCTIONS_FILE),
      "# Agent instructions\nNo markers here.\n",
    );
    const repo = new Repo(tmp.path);
    expect(repo.hasAgentInstructionsMarkers()).toBe(false);
    expect(repo.hasClaudeInstructionsMarkers()).toBe(false);
  });

  it("returns false when file is missing", () => {
    const tmp = useTmpDir();
    const repo = new Repo(tmp.path);
    expect(repo.agentInstructionsPath()).toBeNull();
    expect(repo.hasAgentInstructionsMarkers()).toBe(false);
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

// --- init heuristics ---

describe("init heuristics", () => {
  it("treats a code repo as a likely source repo", () => {
    const tmp = useTmpDir();
    makeSourceRepo(tmp.path);
    const repo = new Repo(tmp.path);
    expect(repo.isLikelySourceRepo()).toBe(true);
    expect(repo.isLikelyEmptyRepo()).toBe(false);
  });

  it("treats a fresh tree repo as empty enough for in-place init", () => {
    const tmp = useTmpDir();
    makeGitRepo(tmp.path);
    writeFileSync(join(tmp.path, "README.md"), "# My Org Context\n");
    const repo = new Repo(tmp.path);
    expect(repo.isLikelyEmptyRepo()).toBe(true);
    expect(repo.isLikelySourceRepo()).toBe(false);
  });

  it("recognizes a populated tree repo", () => {
    const tmp = useTmpDir();
    makeTreeMetadata(tmp.path);
    writeFileSync(
      join(tmp.path, "NODE.md"),
      "---\ntitle: My Tree\nowners: [alice]\n---\n# Tree\n",
    );
    const repo = new Repo(tmp.path);
    expect(repo.looksLikeTreeRepo()).toBe(true);
    expect(repo.isLikelySourceRepo()).toBe(false);
  });

  it("treats a source repo with installed skill and integration markers as a source repo", () => {
    const tmp = useTmpDir();
    makeSourceRepo(tmp.path);
    makeFramework(tmp.path);
    writeFileSync(
      join(tmp.path, AGENT_INSTRUCTIONS_FILE),
      `${SOURCE_INTEGRATION_MARKER} Use the installed \`first-tree\` skill here.\n`,
    );
    writeFileSync(
      join(tmp.path, CLAUDE_INSTRUCTIONS_FILE),
      `${SOURCE_INTEGRATION_MARKER} Use the installed \`first-tree\` skill here.\n`,
    );
    const repo = new Repo(tmp.path);
    expect(repo.hasSourceWorkspaceIntegration()).toBe(true);
    expect(repo.looksLikeTreeRepo()).toBe(false);
    expect(repo.isLikelySourceRepo()).toBe(true);
  });

  it("does not mistake the framework source repo for a user tree repo", () => {
    const tmp = useTmpDir();
    makeSourceRepo(tmp.path);
    makeSourceSkill(tmp.path, "0.2.0");
    writeFileSync(join(tmp.path, "src", "cli.ts"), "export {};\n");
    const repo = new Repo(tmp.path);
    expect(repo.looksLikeTreeRepo()).toBe(false);
    expect(repo.isLikelySourceRepo()).toBe(true);
  });
});
