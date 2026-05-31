import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLAUDE_SETTINGS_PATH,
  CODEX_CONFIG_PATH,
  CODEX_HOOKS_PATH,
  ensureAgentContextHooks,
  formatAgentContextHookMessages,
  INJECT_CONTEXT_COMMAND,
} from "../commands/tree/agent-context-hooks.js";
import {
  findUpwardsManagedSourceBinding,
  parseGitHubRepoReference,
  parseManagedSourceBindingText,
  readManagedSourceBinding,
  readSourceBindingContract,
  SOURCE_INTEGRATION_BEGIN,
  SOURCE_INTEGRATION_END,
} from "../commands/tree/binding-contract.js";
import { writeSourceState } from "../commands/tree/binding-state.js";
import { collectEntries, formatOwners, generateCodeowners, parseOwners } from "../commands/tree/codeowners-lib.js";
import { collectSkillDiagnosis, SKILL_NAMES, type SkillName } from "../commands/tree/skill-lib.js";
import {
  buildSourceIntegrationBlock,
  ensureWhitepaperSymlink,
  readManagedWhitepaperTarget,
  removeManagedWhitepaper,
  upsertLocalTreeGitIgnore,
  upsertSourceIntegrationFiles,
} from "../commands/tree/source-integration.js";
import { runValidateMembers } from "../commands/tree/validate-members.js";

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

function installSkill(root: string, name: SkillName): void {
  const skillRoot = join(root, ".agents", "skills", name);
  mkdirSync(join(skillRoot, "agents"), { recursive: true });
  writeFileSync(
    join(skillRoot, "SKILL.md"),
    `---\nname: ${name}\nversion: 1.0.0\ncliCompat:\n  first-tree: ">=0.0.0"\n---\n`,
  );
  writeFileSync(join(skillRoot, "VERSION"), "1.0.0\n");
  writeFileSync(join(skillRoot, "agents", "openai.yaml"), "name: test\n");
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("tree helper coverage", () => {
  it("updates source integration files, gitignore entries, and managed whitepaper links", () => {
    const root = makeTempDir("ft-tree-source-integration-extra-");

    const sharedBlock = buildSourceIntegrationBlock("context-tree", {
      sourceStatePath: ".first-tree/source.json",
      treeMode: "shared",
      treeRepoUrl: "https://github.com/acme/context-tree.git",
    });
    expect(sharedBlock).toContain("source repo bound to shared tree repo");
    expect(sharedBlock).toContain(".first-tree/source.json");
    expect(sharedBlock).toContain("acme/context-tree");

    write(root, "AGENTS.md", "# Existing\n");
    const first = upsertSourceIntegrationFiles(root, "context-tree", {
      bindingMode: "workspace-root",
      treeMode: "shared",
      treeRepoUrl: "https://github.com/acme/context-tree.git",
      workspaceId: "workspace-1",
    });
    expect(first.map((item) => item.action)).toEqual(["updated", "created"]);
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain("# Existing\n\n<!-- BEGIN FIRST-TREE");

    const second = upsertSourceIntegrationFiles(root, "context-tree", {
      bindingMode: "workspace-root",
      treeMode: "shared",
      treeRepoUrl: "https://github.com/acme/context-tree.git",
      workspaceId: "workspace-1",
    });
    expect(second.map((item) => item.action)).toEqual(["unchanged", "unchanged"]);

    expect(upsertLocalTreeGitIgnore(root)).toEqual({ action: "created", file: ".gitignore" });
    expect(upsertLocalTreeGitIgnore(root)).toEqual({ action: "unchanged", file: ".gitignore" });
    write(root, ".gitignore", "dist/\n");
    expect(upsertLocalTreeGitIgnore(root)).toEqual({ action: "updated", file: ".gitignore" });

    expect(readManagedWhitepaperTarget(root)).toBeNull();
    expect(ensureWhitepaperSymlink(root)).toBe("created");
    expect(readManagedWhitepaperTarget(root)).toBe(join(".agents", "skills", "first-tree", "SKILL.md"));
    removeManagedWhitepaper(root);
    expect(existsSync(join(root, "WHITEPAPER.md"))).toBe(false);
  });

  it("parses managed binding contracts and legacy source state fallbacks", () => {
    const root = makeTempDir("ft-tree-binding-contract-extra-");
    const child = join(root, "packages", "cli");
    mkdirSync(child, { recursive: true });

    expect(parseGitHubRepoReference("https://gitlab.com/acme/context-tree.git")).toBeUndefined();
    expect(
      parseManagedSourceBindingText(
        `${SOURCE_INTEGRATION_BEGIN}\n<!--\nFIRST-TREE-BINDING-MODE: invalid\nFIRST-TREE-TREE-REPO: \`context-tree\`\nFIRST-TREE-TREE-REPO-URL: pending publish\n-->\n${SOURCE_INTEGRATION_END}`,
      ),
    ).toMatchObject({
      bindingContract: "managed-block-v1",
      treeRepoName: "context-tree",
    });
    expect(
      parseManagedSourceBindingText(`${SOURCE_INTEGRATION_BEGIN}\n<!-- bad -->\n${SOURCE_INTEGRATION_END}`),
    ).toBeUndefined();

    write(
      root,
      "CLAUDE.md",
      buildSourceIntegrationBlock("context-tree", {
        bindingMode: "workspace-member",
        entrypoint: "/repos/cli",
        treeMode: "shared",
        treeRepoUrl: "https://github.com/acme/context-tree.git",
        workspaceId: "workspace-1",
      }),
    );
    expect(readManagedSourceBinding(root)).toMatchObject({
      bindingMode: "workspace-member",
      file: "CLAUDE.md",
      scope: "workspace",
      treeRepoSlug: "acme/context-tree",
    });
    expect(findUpwardsManagedSourceBinding(child)).toMatchObject({ workspaceId: "workspace-1" });

    const legacy = makeTempDir("ft-tree-binding-legacy-extra-");
    writeSourceState(legacy, {
      bindingMode: "shared-source",
      rootKind: "git-repo",
      scope: "repo",
      sourceId: "source-1",
      sourceName: "cli",
      tree: {
        entrypoint: "/",
        remoteUrl: "git@github.com:acme/context-tree.git",
        treeId: "tree-1",
        treeMode: "shared",
        treeRepoName: "context-tree",
      },
      workspaceId: "workspace-1",
    });
    expect(readSourceBindingContract(legacy)).toMatchObject({
      bindingContract: "legacy-source-state",
      sourceStatePath: ".first-tree/source.json",
      treeRepoSlug: "acme/context-tree",
      workspaceId: "workspace-1",
    });
  });

  it("covers CODEOWNERS parsing, inheritance, wildcard skips, and drift checks", () => {
    const root = makeTempDir("ft-tree-codeowners-extra-");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    write(root, "plain.md", "# No frontmatter\n");
    write(root, "no-owners.md", "---\ntitle: No owners\n---\n");
    write(root, "empty-owners.md", "---\nowners: []\n---\n");
    expect(parseOwners(join(root, "plain.md"))).toBeNull();
    expect(parseOwners(join(root, "no-owners.md"))).toBeNull();
    expect(parseOwners(join(root, "empty-owners.md"))).toEqual([]);
    expect(formatOwners(["@@alice", "alice", "", "@bob"])).toBe("@alice @bob");

    write(root, "NODE.md", "---\nowners: [root]\n---\n");
    write(root, "area/NODE.md", "---\nowners: []\n---\n");
    write(root, "area/leaf.md", "---\nowners: [area-leaf]\n---\n");
    write(root, "area/public.md", "---\nowners: [*]\n---\n");
    write(root, "area/nested/readme.txt", "skip\n");
    write(root, "root-leaf.md", "---\nowners: [root-leaf]\n---\n");
    mkdirSync(join(root, "node_modules", "ignored"), { recursive: true });
    symlinkSync("missing-target", join(root, "area", "broken-link"));
    symlinkSync("missing-target", join(root, "broken-root-link"));

    const entries = collectEntries(root);
    expect(entries).toContainEqual(["/*", ["root"]]);
    expect(entries).toContainEqual(["/area/", ["root"]]);
    expect(entries).toContainEqual(["/area/leaf.md", ["root", "area-leaf"]]);
    expect(entries).not.toContainEqual(["/area/public.md", ["root", "*"]]);
    expect(entries).toContainEqual(["/root-leaf.md", ["root", "root-leaf"]]);

    expect(generateCodeowners(root, { check: true })).toBe(1);
    generateCodeowners(root);
    expect(generateCodeowners(root, { check: true })).toBe(0);
  });

  it("migrates agent context hooks from invalid or stale existing config", () => {
    const root = makeTempDir("ft-tree-hooks-extra-");
    mkdirSync(join(root, ".claude"), { recursive: true });
    mkdirSync(join(root, ".codex"), { recursive: true });
    writeFileSync(join(root, CLAUDE_SETTINGS_PATH), "{ invalid json");
    writeFileSync(join(root, CODEX_CONFIG_PATH), "[features]\n[tools]\n");
    writeFileSync(
      join(root, CODEX_HOOKS_PATH),
      JSON.stringify({
        hooks: {
          SessionStart: [
            "keep-me",
            { hooks: [{ type: "command", command: ".context-tree/scripts/inject-tree-context.sh" }] },
            { hooks: [{ type: "prompt", command: INJECT_CONTEXT_COMMAND }] },
          ],
        },
      }),
    );

    expect(
      formatAgentContextHookMessages({ claudeSettings: "updated", codexConfig: "unchanged", codexHooks: "updated" }),
    ).toEqual([
      "Updated `.claude/settings.json` to use the first-tree SessionStart hook.",
      "Updated `.codex/hooks.json` to use the first-tree `SessionStart` hook.",
    ]);

    const result = ensureAgentContextHooks(root);
    expect(result).toEqual({ claudeSettings: "updated", codexConfig: "updated", codexHooks: "updated" });
    const config = readFileSync(join(root, CODEX_CONFIG_PATH), "utf8");
    expect(config).toContain("[features]\ncodex_hooks = true\n[tools]");
    const hooks = readFileSync(join(root, CODEX_HOOKS_PATH), "utf8");
    expect(hooks).toContain("keep-me");
    expect(hooks).toContain('"type": "prompt"');
    expect(hooks).toContain(INJECT_CONTEXT_COMMAND);
  });

  it("reports member validation edge cases", () => {
    const root = makeTempDir("ft-tree-validate-members-extra-");
    write(root, "members/alice/NODE.md", "# Missing frontmatter\n");
    write(root, "members/bob/NODE.md", '---\nowners: []\ntype: robot\nstatus: active\nrole: ""\ndomains: []\n---\n');
    symlinkSync("missing-target", join(root, "members", "broken-link"));

    const result = runValidateMembers(root);
    expect(result.exitCode).toBe(1);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        "members/alice/NODE.md: no frontmatter found",
        "members/bob/NODE.md: missing or empty 'title' field",
        "members/bob/NODE.md: invalid type 'robot' — must be one of: agent, human",
        "members/bob/NODE.md: invalid status 'active' — must be one of: invited",
        "members/bob/NODE.md: missing or empty 'role' field",
        "members/bob/NODE.md: 'domains' must contain at least one entry",
      ]),
    );
  });

  it("diagnoses Claude skill directories as non-symlink installs", () => {
    const root = makeTempDir("ft-tree-skill-diagnosis-extra-");
    installSkill(root, "attention");
    mkdirSync(join(root, ".claude", "skills", "attention"), { recursive: true });

    const attention = collectSkillDiagnosis(root).find((row) => row.name === "attention");
    expect(attention?.problems).toContain(
      ".claude/skills/attention should be a symlink to ../../.agents/skills/attention",
    );
    expect(collectSkillDiagnosis(root)).toHaveLength(SKILL_NAMES.length);
  });
});
