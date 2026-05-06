import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(testDir, "..");
const repoRoot = resolve(cliRoot, "../..");
const entryPath = resolve(cliRoot, "dist/index.js");
const rootPackagePath = resolve(repoRoot, "package.json");
const cliPackagePath = resolve(cliRoot, "package.json");
const commandNames = ["tree", "github", "hub"];
const rootHelpCommandPaths = [
  "first-tree tree inspect",
  "first-tree tree skill install",
  "first-tree github scan",
  "first-tree hub start",
];
const commandGroups = [
  {
    name: "tree",
    subcommands: ["inspect", "status", "init", "workspace", "skill", "help"],
  },
  {
    name: "github",
    subcommands: ["scan"],
  },
  {
    name: "hub",
    subcommands: ["start", "stop", "doctor", "status"],
  },
];

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function makeGitRepoDir(prefix) {
  const dir = await mkdtemp(resolve(tmpdir(), prefix));
  await writeFile(resolve(dir, ".git"), "gitdir: /tmp/mock\n");
  return dir;
}

function runCli(args, options = {}) {
  return new Promise((resolveRun) => {
    execFile(
      process.execPath,
      [entryPath, ...args],
      { cwd: options.cwd ?? repoRoot },
      (error, stdout, stderr) => {
        resolveRun({
          code: error && "code" in error ? error.code : 0,
          stdout,
          stderr,
        });
      },
    );
  });
}

describe("first-tree CLI", () => {
  it("prints the workspace package version", async () => {
    const rootPackage = await readJson(rootPackagePath);
    const cliPackage = await readJson(cliPackagePath);
    const result = await runCli(["--version"]);

    expect(cliPackage.version).toBe(rootPackage.version);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe(rootPackage.version);
  });

  it("prints help with registered commands", async () => {
    const result = await runCli(["--help"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: first-tree");
    expect(result.stdout).toContain("CLI for Context Tree, GitHub Scan, and Hub workflows.");
    expect(result.stdout).toContain("--json");
    expect(result.stdout).toContain("-d, --debug");
    expect(result.stdout).toContain("-q, --quiet");
    for (const commandName of commandNames) {
      expect(result.stdout).toContain(commandName);
    }
    expect(result.stdout).toContain("All commands:");
    for (const commandPath of rootHelpCommandPaths) {
      expect(result.stdout).toContain(commandPath);
    }
  });

  it("prints inspect output for the current repo", async () => {
    const cwd = await makeGitRepoDir("first-tree-inspect-");
    const result = await runCli(["tree", "inspect"], { cwd });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("first-tree tree inspect");
    expect(result.stdout).toContain("classification: git-repo");
  });

  it("prints inspect json for the current repo", async () => {
    const cwd = await makeGitRepoDir("first-tree-inspect-json-");
    const result = await runCli(["tree", "inspect", "--json"], { cwd });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain('"classification": "git-repo"');
  });

  it("prints onboarding help from the tree help namespace", async () => {
    const result = await runCli(["tree", "help", "onboarding"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("first-tree tree help onboarding");
    expect(result.stdout).toContain("github scan");
  });

  it("reports a missing shared tree for workspace sync", async () => {
    const workspaceRoot = await mkdtemp(resolve(tmpdir(), "first-tree-workspace-missing-"));
    const repoA = resolve(workspaceRoot, "repo-a");
    const repoB = resolve(workspaceRoot, "repo-b");
    await mkdir(repoA, { recursive: true });
    await mkdir(repoB, { recursive: true });
    await writeFile(resolve(repoA, ".git"), "gitdir: /tmp/repo-a\n");
    await writeFile(resolve(repoB, ".git"), "gitdir: /tmp/repo-b\n");

    const workspaceResult = await runCli(["tree", "workspace", "sync"], { cwd: workspaceRoot });

    expect(workspaceResult.code).toBe(1);
    expect(workspaceResult.stdout).toBe("");
    expect(workspaceResult.stderr).toContain(
      "Could not resolve the shared tree for this workspace.",
    );
  });

  it("bootstraps a tree repo checkout", async () => {
    const treeRoot = await mkdtemp(resolve(tmpdir(), "first-tree-bootstrap-"));
    const result = await runCli(["tree", "bootstrap", "--tree-path", treeRoot]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Context Tree Bootstrap");
    expect(await readFile(resolve(treeRoot, "NODE.md"), "utf8")).toContain("# Context Tree");
    expect(await readFile(resolve(treeRoot, "AGENTS.md"), "utf8")).toContain(
      "BEGIN FIRST-TREE-TREE-IDENTITY",
    );
    await expect(readFile(resolve(treeRoot, ".first-tree", "tree.json"), "utf8")).rejects.toThrow();
    expect(
      await readFile(resolve(treeRoot, ".first-tree", "agent-templates", "developer.yaml"), "utf8"),
    ).toContain("name: developer");
    expect(
      await readFile(
        resolve(treeRoot, ".first-tree", "agent-templates", "code-reviewer.yaml"),
        "utf8",
      ),
    ).toContain("name: code-reviewer");
    expect(await readFile(resolve(treeRoot, ".first-tree", "org.yaml"), "utf8")).toContain(
      "humanInvolveRules:",
    );
  });

  it("binds a source repo to a tree repo", async () => {
    const sourceRoot = await makeGitRepoDir("first-tree-bind-source-");
    const treeRoot = await makeGitRepoDir("first-tree-bind-tree-");
    const result = await runCli(["tree", "bind", "--tree-path", treeRoot], { cwd: sourceRoot });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Context Tree Bind");
    expect(result.stdout).toContain("managed identity block");
    await expect(
      readFile(resolve(sourceRoot, ".first-tree", "source.json"), "utf8"),
    ).rejects.toThrow();
    expect(await readFile(resolve(sourceRoot, "AGENTS.md"), "utf8")).toContain("managed-block-v1");
    expect(await readFile(resolve(treeRoot, "AGENTS.md"), "utf8")).toContain(
      "BEGIN FIRST-TREE-TREE-IDENTITY",
    );
  });

  it("prints workspace sync dry-run json", async () => {
    const workspaceRoot = await mkdtemp(resolve(tmpdir(), "first-tree-workspace-"));
    const treeRoot = await makeGitRepoDir("first-tree-workspace-tree-");
    const repoA = resolve(workspaceRoot, "repo-a");
    const repoB = resolve(workspaceRoot, "nested", "repo-b");

    await mkdir(repoA, { recursive: true });
    await mkdir(repoB, { recursive: true });
    await writeFile(resolve(workspaceRoot, ".git"), "gitdir: /tmp/workspace\n");
    await writeFile(resolve(repoA, ".git"), "gitdir: /tmp/repo-a\n");
    await writeFile(resolve(repoB, ".git"), "gitdir: /tmp/repo-b\n");

    const result = await runCli(
      ["tree", "workspace", "sync", "--tree-path", treeRoot, "--dry-run", "--json"],
      { cwd: workspaceRoot },
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain('"childRepos"');
    expect(result.stdout).toContain('"repo-a"');
    expect(result.stdout).toContain('"nested/repo-b"');
  });

  it("preserves the workspace root entrypoint after binding child members", async () => {
    const workspaceRoot = await mkdtemp(resolve(tmpdir(), "first-tree-ws-entrypoint-"));
    const treeRoot = await mkdtemp(resolve(tmpdir(), "first-tree-ws-entrypoint-tree-"));
    const repoA = resolve(workspaceRoot, "repo-a");
    const repoB = resolve(workspaceRoot, "repo-b");
    await mkdir(repoA, { recursive: true });
    await mkdir(repoB, { recursive: true });
    await writeFile(resolve(repoA, ".git"), "gitdir: /tmp/repo-a\n");
    await writeFile(resolve(repoB, ".git"), "gitdir: /tmp/repo-b\n");

    const initResult = await runCli(
      [
        "tree",
        "init",
        "--tree-path",
        treeRoot,
        "--tree-mode",
        "shared",
        "--scope",
        "workspace",
        "--workspace-id",
        "ws-entrypoint-test",
      ],
      { cwd: workspaceRoot },
    );
    expect(initResult.code).toBe(0);
    expect(initResult.stderr).toBe("");

    await expect(
      readFile(resolve(workspaceRoot, ".first-tree", "source.json"), "utf8"),
    ).rejects.toThrow();
    expect(await readFile(resolve(workspaceRoot, "AGENTS.md"), "utf8")).toContain(
      "FIRST-TREE-ENTRYPOINT: `/workspaces/ws-entrypoint-test`",
    );
    expect(await readFile(resolve(repoA, "AGENTS.md"), "utf8")).toContain(
      "FIRST-TREE-ENTRYPOINT: `/workspaces/ws-entrypoint-test/repos/repo-a`",
    );
    expect(await readFile(resolve(repoB, "AGENTS.md"), "utf8")).toContain(
      "FIRST-TREE-ENTRYPOINT: `/workspaces/ws-entrypoint-test/repos/repo-b`",
    );
  });

  it("verifies a freshly initialized tree (init -> verify happy path)", async () => {
    const sourceRoot = await makeGitRepoDir("first-tree-init-verify-source-");
    const treeRoot = await mkdtemp(resolve(tmpdir(), "first-tree-init-verify-tree-"));

    const initResult = await runCli(
      ["tree", "init", "--tree-path", treeRoot, "--tree-mode", "dedicated", "--scope", "repo"],
      { cwd: sourceRoot },
    );
    expect(initResult.code).toBe(0);
    expect(initResult.stderr).toBe("");

    const verifyResult = await runCli(["tree", "verify", "--json"], { cwd: treeRoot });
    expect(verifyResult.stderr).toBe("");
    expect(verifyResult.stdout).toContain('"ok": true');
    expect(verifyResult.code).toBe(0);
  });

  it("verifies a simple tree repo", async () => {
    const treeRoot = await makeGitRepoDir("first-tree-verify-tree-");
    await mkdir(resolve(treeRoot, ".first-tree"), { recursive: true });
    await mkdir(resolve(treeRoot, "members", "alice"), { recursive: true });
    await writeFile(
      resolve(treeRoot, "NODE.md"),
      `---\ntitle: Context Tree\nowners: [alice]\n---\n\n# Context Tree\n`,
    );
    await writeFile(
      resolve(treeRoot, "AGENTS.md"),
      [
        "<!-- BEGIN CONTEXT-TREE FRAMEWORK -->",
        "<!-- END CONTEXT-TREE FRAMEWORK -->",
        "",
        "<!-- BEGIN FIRST-TREE-TREE-IDENTITY -->",
        "## Tree Identity",
        "",
        "> Managed block — regenerated by `first-tree` tooling. Do not edit by hand.",
        "",
        "- **Tree repo:** `context-tree`",
        "- **Tree mode:** `shared`",
        "- **Published tree URL:** _pending publish_",
        "",
        "<!--",
        "FIRST-TREE-TREE-IDENTITY: managed-block-v1",
        "FIRST-TREE-TREE-REPO: `context-tree`",
        "FIRST-TREE-TREE-MODE: `shared`",
        "FIRST-TREE-TREE-PUBLISHED-URL: pending publish",
        "-->",
        "<!-- END FIRST-TREE-TREE-IDENTITY -->",
        "",
      ].join("\n"),
    );
    await writeFile(resolve(treeRoot, "CLAUDE.md"), "<!-- BEGIN CONTEXT-TREE FRAMEWORK -->\n");
    await writeFile(resolve(treeRoot, ".first-tree", "VERSION"), "0.4.0-alpha.1\n");
    await writeFile(resolve(treeRoot, ".first-tree", "progress.md"), "- [x] bootstrap\n");
    await writeFile(
      resolve(treeRoot, "members", "NODE.md"),
      `---\ntitle: Members\nowners: [alice]\n---\n\n# Members\n`,
    );
    await writeFile(
      resolve(treeRoot, "members", "alice", "NODE.md"),
      `---\ntitle: Alice\nowners: [alice]\ntype: human\nrole: owner\ndomains: [core]\n---\n\n# Alice\n`,
    );

    const result = await runCli(["tree", "verify", "--json"], { cwd: treeRoot });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain('"ok": true');
  });

  it("generates CODEOWNERS for a simple tree repo", async () => {
    const treeRoot = await makeGitRepoDir("first-tree-codeowners-tree-");
    await mkdir(resolve(treeRoot, "members", "alice"), { recursive: true });
    await writeFile(
      resolve(treeRoot, "NODE.md"),
      `---\ntitle: Context Tree\nowners: [alice]\n---\n\n# Context Tree\n`,
    );
    await writeFile(
      resolve(treeRoot, "members", "NODE.md"),
      `---\ntitle: Members\nowners: [alice]\n---\n\n# Members\n`,
    );
    await writeFile(
      resolve(treeRoot, "members", "alice", "NODE.md"),
      `---\ntitle: Alice\nowners: [alice]\ntype: human\nrole: owner\ndomains: [core]\n---\n\n# Alice\n`,
    );

    const writeResult = await runCli(["tree", "generate-codeowners"], { cwd: treeRoot });
    const checkResult = await runCli(["tree", "generate-codeowners", "--check"], { cwd: treeRoot });

    expect(writeResult.code).toBe(0);
    expect(writeResult.stderr).toBe("");
    expect(writeResult.stdout).toContain("Wrote .github/CODEOWNERS");
    expect(await readFile(resolve(treeRoot, ".github", "CODEOWNERS"), "utf8")).toContain("@alice");
    expect(checkResult.code).toBe(0);
    expect(checkResult.stdout).toContain("CODEOWNERS is up-to-date.");
  });

  it("installs managed SessionStart hooks", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "first-tree-hooks-"));
    const result = await runCli(["tree", "install-claude-code-hook", "--root", root]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(".claude/settings.json");
    const claudeSettings = await readFile(resolve(root, ".claude", "settings.json"), "utf8");
    const codexHooks = await readFile(resolve(root, ".codex", "hooks.json"), "utf8");
    expect(claudeSettings).toContain("first-tree tree inject-context");
    expect(claudeSettings).not.toContain("--skip-version-check");
    expect(await readFile(resolve(root, ".codex", "config.toml"), "utf8")).toContain(
      "codex_hooks = true",
    );
    expect(codexHooks).toContain("Loading First Tree context");
    expect(codexHooks).not.toContain("--skip-version-check");
  });

  it("emits inject-context payload from a local tree repo", async () => {
    const treeRoot = await makeGitRepoDir("first-tree-inject-tree-");
    await writeFile(resolve(treeRoot, "NODE.md"), "# Root\nbody\n");

    const result = await runCli(["tree", "inject-context"], { cwd: treeRoot });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout);
    expect(payload.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(payload.hookSpecificOutput.additionalContext).toContain("# Root");
  });

  it("installs and inspects shipped skills through `tree skill` commands", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "first-tree-skill-install-"));

    const installResult = await runCli(["tree", "skill", "install", "--root", root]);
    const listResult = await runCli(["tree", "skill", "list", "--root", root]);
    const listJsonResult = await runCli(["tree", "skill", "list", "--root", root, "--json"]);
    const doctorResult = await runCli(["tree", "skill", "doctor", "--root", root]);
    const linkResult = await runCli(["tree", "skill", "link", "--root", root]);

    expect(installResult.code).toBe(0);
    expect(installResult.stdout).toContain("Installed 6 shipped first-tree skills");

    expect(listResult.code).toBe(0);
    expect(listResult.stdout).toContain("first-tree-onboarding");
    expect(listResult.stdout).toContain("github-scan");
    expect(listResult.stdout).toContain("installed");
    const listJson = JSON.parse(listJsonResult.stdout);
    expect(listJson[0].cliCompat).toBe(">=0.4.0 <0.5.0");
    expect(listJson[0].cliVersion).toBe("0.4.0-alpha.1");
    expect(listJson.some((row) => row.name === "github-scan")).toBe(true);

    expect(doctorResult.code).toBe(0);
    expect(doctorResult.stdout).toContain("OK first-tree");
    expect(doctorResult.stdout).toContain("OK first-tree-github-scan");
    expect(doctorResult.stdout).toContain("OK github-scan");

    expect(linkResult.code).toBe(0);
    expect(linkResult.stdout).toContain("Linked");

    // Healthy `skill list` non-JSON output should mark every skill `installed`,
    // not `incompatible`.
    expect(listResult.stdout).not.toContain("incompatible");
    // Healthy `skill list --json` rows should expose `compatible: true`.
    for (const row of listJson) {
      expect(row.compatible).toBe(true);
    }
  });

  it("flags incompatible cliCompat in `skill list` and gives a CLI-version fix hint in `skill doctor`", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "first-tree-skill-incompat-"));

    const installResult = await runCli(["tree", "skill", "install", "--root", root]);
    expect(installResult.code).toBe(0);

    // Force one skill's cliCompat range to require an unreachable major. The
    // current CLI is 0.4.x; >=99.0.0 cannot match.
    const skillPath = resolve(root, ".agents", "skills", "first-tree-onboarding", "SKILL.md");
    const original = await readFile(skillPath, "utf8");
    await writeFile(skillPath, original.replace(/>=0\.4\.0 <0\.5\.0/u, ">=99.0.0"));

    const listResult = await runCli(["tree", "skill", "list", "--root", root]);
    const listJsonResult = await runCli(["tree", "skill", "list", "--root", root, "--json"]);
    const doctorResult = await runCli(["tree", "skill", "doctor", "--root", root]);
    const doctorJsonResult = await runCli(["tree", "skill", "doctor", "--root", root, "--json"]);

    expect(listResult.code).toBe(0);
    expect(listResult.stdout).toMatch(/first-tree-onboarding\s+incompatible/u);

    const listJson = JSON.parse(listJsonResult.stdout);
    const onboardingStatus = listJson.find((row) => row.name === "first-tree-onboarding");
    expect(onboardingStatus.compatible).toBe(false);
    const otherStatuses = listJson.filter((row) => row.name !== "first-tree-onboarding");
    for (const row of otherStatuses) {
      expect(row.compatible).toBe(true);
    }

    expect(doctorResult.code).toBe(1);
    expect(doctorResult.stdout).toContain("first-tree-onboarding requires first-tree >=99.0.0");
    expect(doctorResult.stdout).toContain("These skills require a different CLI version");
    // The generic link/upgrade hint should NOT appear when the only failures
    // are cliCompat mismatches — those are not fixable by re-copying payloads.
    expect(doctorResult.stdout).not.toContain("Repair shipped skill payloads with:");

    const doctorJson = JSON.parse(doctorJsonResult.stdout);
    const onboardingDiagnosis = doctorJson.find((row) => row.name === "first-tree-onboarding");
    expect(onboardingDiagnosis.ok).toBe(false);
    expect(onboardingDiagnosis.incompatibleCliCompat).toBe(">=99.0.0");
  });

  it("runs bare `github scan` and prints help with exit 0", async () => {
    const result = await runCli(["github", "scan"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("usage: first-tree github scan");
    expect(result.stdout).toContain("GitHub Scan is the GitHub notification daemon");
  });

  it("passes github scan args through without commander interception", async () => {
    const result = await runCli(["github", "scan", "status", "--allow-repo", "foo"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("first-tree github scan");
    expect(result.stderr).toContain("invalid repo allow pattern");
  });

  it("fails closed when github scan poll has no tree binding", async () => {
    const cwd = await makeGitRepoDir("first-tree-no-binding-");
    const result = await runCli(["github", "scan", "poll", "--allow-repo", "owner/repo"], { cwd });

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("requires a bound tree repo");
    expect(result.stderr).toContain("first-tree tree bind");
  });

  it("forwards --help to github scan", async () => {
    const result = await runCli(["github", "scan", "--help"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("usage: first-tree github scan");
  });

  for (const commandGroup of commandGroups) {
    it(`prints ${commandGroup.name} help with registered subcommands`, async () => {
      const result = await runCli([commandGroup.name, "--help"]);

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(`Usage: first-tree ${commandGroup.name}`);
      expect(result.stdout).not.toContain("All commands:");
      for (const subcommandName of commandGroup.subcommands) {
        expect(result.stdout).toContain(subcommandName);
      }
    });

    it(`prints ${commandGroup.name} help when no subcommand is provided`, async () => {
      const result = await runCli([commandGroup.name]);

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(`Usage: first-tree ${commandGroup.name}`);
      expect(result.stdout).not.toContain("All commands:");
      for (const subcommandName of commandGroup.subcommands) {
        expect(result.stdout).toContain(subcommandName);
      }
    });
  }

  it("prints nested tree group help", async () => {
    const skillHelp = await runCli(["tree", "skill"]);
    const workspaceHelp = await runCli(["tree", "workspace"]);

    expect(skillHelp.code).toBe(0);
    expect(skillHelp.stdout).toContain("Usage: first-tree tree skill");
    expect(skillHelp.stdout).toContain("install");

    expect(workspaceHelp.code).toBe(0);
    expect(workspaceHelp.stdout).toContain("Usage: first-tree tree workspace");
    expect(workspaceHelp.stdout).toContain("sync");
  });

  it("fails hub placeholder commands with a not-implemented error", async () => {
    const result = await runCli(["hub", "start"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("first-tree hub start is not implemented yet.");
    expect(result.stderr).toContain("Usage: first-tree hub start");
  });

  it("prints subcommand help after an invalid option", async () => {
    const result = await runCli(["tree", "generate-codeowners", "--bad-option"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("error: unknown option '--bad-option'");
    expect(result.stderr).toContain("Usage: first-tree tree generate-codeowners");
    expect(result.stderr).toContain("Options:");
  });

  it("suggests a third-level subcommand for an unknown typo", async () => {
    const result = await runCli(["tree", "inspec"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("error: unknown command 'inspec'");
    expect(result.stderr).toContain("(Did you mean inspect?)");
  });

  it("keeps a shebang on the compiled entry", async () => {
    const entrySource = await readFile(entryPath, "utf8");

    expect(entrySource.startsWith("#!/usr/bin/env node\n")).toBe(true);
  });

  it("runs through a bin-style symlink", async () => {
    const rootPackage = await readJson(rootPackagePath);
    const tempDir = await mkdtemp(resolve(tmpdir(), "first-tree-bin-"));
    const binPath = resolve(tempDir, "first-tree");

    try {
      await symlink(entryPath, binPath);

      const result = await new Promise((resolveRun) => {
        execFile(
          process.execPath,
          [binPath, "--version"],
          { cwd: repoRoot },
          (error, stdout, stderr) => {
            resolveRun({
              code: error && "code" in error ? error.code : 0,
              stdout,
              stderr,
            });
          },
        );
      });

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.trim()).toBe(rootPackage.version);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("exposes first-tree and ft bins through the compiled entry", async () => {
    const cliPackage = await readJson(cliPackagePath);

    expect(cliPackage.bin).toEqual({
      "first-tree": "./dist/index.js",
      ft: "./dist/index.js",
    });
  });
});
