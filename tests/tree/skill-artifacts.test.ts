import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = process.cwd();

function trackedEntriesInGit(...relativePaths: string[]): string[] {
  const result = spawnSync("git", ["ls-files", ...relativePaths], {
    cwd: ROOT,
    stdio: "pipe",
  });
  return result.stdout
    ?.toString()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean) ?? [];
}

describe("skill artifacts", () => {
  it("keeps one canonical skill plus local alias entrypoints in the source repo", () => {
    expect(existsSync(join(ROOT, "skills", "first-tree", "SKILL.md"))).toBe(true);
    expect(existsSync(join(ROOT, "skills", "first-tree", "VERSION"))).toBe(true);
    expect(existsSync(join(ROOT, "skills", "first-tree", "references", "onboarding.md"))).toBe(true);
    expect(
      existsSync(
        join(
          ROOT,
          "skills",
          "first-tree",
          "references",
          "source-workspace-installation.md",
        ),
      ),
    ).toBe(true);
    expect(existsSync(join(ROOT, "assets", "tree", "manifest.json"))).toBe(true);
    expect(existsSync(join(ROOT, "assets", "tree", "templates", "agents.md.template"))).toBe(true);
    expect(existsSync(join(ROOT, "src", "products", "tree", "engine", "init.ts"))).toBe(true);
    expect(
      existsSync(join(ROOT, "src", "products", "tree", "engine", "member-seeding.ts")),
    ).toBe(true);
    expect(existsSync(join(ROOT, "src", "products", "tree", "VERSION"))).toBe(true);
    expect(existsSync(join(ROOT, "src", "products", "breeze", "VERSION"))).toBe(true);
    expect(existsSync(join(ROOT, "src", "products", "breeze", "cli.ts"))).toBe(true);
    expect(existsSync(join(ROOT, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(ROOT, "WHITEPAPER.md"))).toBe(true);
    expect(existsSync(join(ROOT, ".agents", "skills", "first-tree", "SKILL.md"))).toBe(true);
    expect(existsSync(join(ROOT, ".claude", "skills", "first-tree", "SKILL.md"))).toBe(true);
    expect(lstatSync(join(ROOT, "CLAUDE.md")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(ROOT, "CLAUDE.md"))).toBe("AGENTS.md");
    expect(lstatSync(join(ROOT, "WHITEPAPER.md")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(ROOT, "WHITEPAPER.md"))).toBe(
      ".agents/skills/first-tree/references/whitepaper.md",
    );
    expect(lstatSync(join(ROOT, ".agents", "skills", "first-tree")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(ROOT, ".agents", "skills", "first-tree"))).toBe(
      "../../skills/first-tree",
    );
    expect(lstatSync(join(ROOT, ".claude", "skills", "first-tree")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(ROOT, ".claude", "skills", "first-tree"))).toBe(
      "../../.agents/skills/first-tree",
    );
    expect(existsSync(join(ROOT, "tests", "tree", "init.test.ts"))).toBe(
      true,
    );
    expect(
      existsSync(join(ROOT, "tests", "tree", "member-seeding.test.ts")),
    ).toBe(true);
    expect(
      existsSync(
        join(ROOT, "evals", "first-tree-eval.test.ts"),
      ),
    ).toBe(true);
    expect(
      existsSync(join(ROOT, "src", "products", "tree", "engine", "runtime", "asset-loader.ts")),
    ).toBe(true);
    expect(
      existsSync(
        join(ROOT, "src", "products", "tree", "engine", "runtime", "source-integration.ts"),
      ),
    ).toBe(true);
    expect(
      existsSync(join(ROOT, "src", "products", "tree", "engine", "rules", "index.ts")),
    ).toBe(true);
    expect(
      existsSync(join(ROOT, "src", "products", "tree", "engine", "validators", "nodes.ts")),
    ).toBe(true);
    expect(
      existsSync(join(ROOT, "docs", "architecture", "overview.md")),
    ).toBe(true);
    expect(
      existsSync(join(ROOT, "docs", "architecture", "thin-cli.md")),
    ).toBe(true);
    expect(
      existsSync(join(ROOT, "docs", "build", "distribution.md")),
    ).toBe(true);
    expect(
      existsSync(join(ROOT, "docs", "testing", "overview.md")),
    ).toBe(true);
    expect(
      existsSync(join(ROOT, "docs", "design", "sync.md")),
    ).toBe(true);
    const allowedAliases = new Set([
      ".agents/skills/first-tree",
      ".agents/skills/tree",
      ".agents/skills/breeze",
      ".agents/skills/gardener",
      ".claude/skills/first-tree",
      ".claude/skills/tree",
      ".claude/skills/breeze",
      ".claude/skills/gardener",
    ]);
    expect(
      trackedEntriesInGit(".agents", ".claude").filter(
        (entry) => !allowedAliases.has(entry),
      ),
    ).toEqual([]);
    expect(trackedEntriesInGit(".context-tree")).toEqual([]);
    expect(existsSync(join(ROOT, "AGENT.md"))).toBe(false);
    expect(existsSync(join(ROOT, "evals"))).toBe(true);
    // Lightweight skill payload must not contain engine/tests/assets/scripts/agents.
    expect(existsSync(join(ROOT, "skills", "first-tree", "engine"))).toBe(false);
    expect(existsSync(join(ROOT, "skills", "first-tree", "tests"))).toBe(false);
    expect(existsSync(join(ROOT, "skills", "first-tree", "assets"))).toBe(false);
    expect(existsSync(join(ROOT, "skills", "first-tree", "scripts"))).toBe(false);
    expect(existsSync(join(ROOT, "skills", "first-tree", "agents"))).toBe(false);
    expect(
      existsSync(join(ROOT, "skills", "first-tree", "references", "repo-snapshot")),
    ).toBe(false);
    expect(existsSync(join(ROOT, "skills", "first-tree", "evals"))).toBe(false);
  });

  it("passes skill validation helpers", () => {
    execFileSync(
      "python3",
      ["./scripts/quick_validate.py", "./skills/first-tree"],
      {
        cwd: ROOT,
        stdio: "pipe",
        encoding: "utf-8",
      },
    );
    execFileSync("bash", ["./scripts/check-skill-sync.sh"], {
      cwd: ROOT,
      stdio: "pipe",
      encoding: "utf-8",
    });
  });

  it("ships the canonical skill in the published tarball", { timeout: 15000 }, () => {
    const packDir = mkdtempSync(join(tmpdir(), "first-tree-pack-"));
    try {
      const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")) as {
        name: string;
        version: string;
      };
      execFileSync("pnpm", ["pack", "--pack-destination", packDir], {
        cwd: ROOT,
        stdio: "pipe",
        encoding: "utf-8",
      });

      const tarball = join(packDir, `${pkg.name}-${pkg.version}.tgz`);
      const listing = execFileSync("tar", ["-tf", tarball], {
        cwd: ROOT,
        stdio: "pipe",
        encoding: "utf-8",
      });

      expect(listing).toContain("package/dist/cli.js");
      expect(listing).toContain("package/src/products/tree/VERSION");
      expect(listing).toContain("package/src/products/breeze/VERSION");
      expect(listing).toContain("package/src/products/gardener/VERSION");
      expect(listing).toContain("package/src/meta/skill-tools/VERSION");
      expect(listing).toContain("package/skills/first-tree/SKILL.md");
      expect(listing).toContain("package/skills/first-tree/VERSION");
      expect(listing).toContain(
        "package/skills/first-tree/references/onboarding.md",
      );
      expect(listing).toContain(
        "package/assets/tree/templates/agents.md.template",
      );
      expect(listing).not.toContain(
        "package/assets/tree/templates/claude.md.template",
      );
      expect(listing).toContain(
        "package/assets/tree/helpers/summarize-progress.js",
      );
      // Lightweight skill payload does not ship engine/tests/agents/scripts.
      expect(listing).not.toContain("package/skills/first-tree/engine/");
      expect(listing).not.toContain("package/skills/first-tree/tests/");
      expect(listing).not.toContain("package/skills/first-tree/agents/");
      expect(listing).not.toContain("package/skills/first-tree/scripts/");
      expect(listing).not.toContain("package/skills/first-tree/assets/");
      expect(listing).not.toContain("package/skills/first-tree/evals/");
      expect(listing).not.toContain("package/evals/");
      expect(listing).not.toContain("package/src/cli.ts");
      expect(listing).not.toContain("package/docs/");
      expect(listing).not.toContain("package/tests/");
    } finally {
      rmSync(packDir, { recursive: true, force: true });
    }
  });

  it("prints namespace versions from the built CLI without unknown placeholders", () => {
    execFileSync("pnpm", ["build"], {
      cwd: ROOT,
      stdio: "pipe",
      encoding: "utf-8",
    });
    const versionLine = execFileSync("node", ["dist/cli.js", "--version"], {
      cwd: ROOT,
      stdio: "pipe",
      encoding: "utf-8",
    }).trim();

    expect(versionLine).toContain("first-tree=");
    expect(versionLine).toContain("tree=");
    expect(versionLine).toContain("breeze=");
    expect(versionLine).toContain("gardener=");
    expect(versionLine).toContain("skill=");
    expect(versionLine).not.toContain("unknown");
  });

  it("keeps naming and installation guidance aligned", () => {
    const read = (path: string) => readFileSync(join(ROOT, path), "utf-8");

    expect(read("README.md")).not.toContain("seed-tree");
    expect(read("AGENTS.md")).not.toContain("seed-tree");
    expect(read("README.md")).toContain("Package And Command");
    expect(read("README.md")).toContain("Canonical Documentation");
    expect(read("README.md")).toContain("docs/source-map.md");
    expect(read("README.md")).toContain("source-workspace-installation.md");
    expect(read("README.md")).toContain("first-tree-skill-cli/repo-architecture.md");
    expect(read("README.md")).toContain("first-tree-skill-cli/sync.md");
    expect(read("README.md")).toContain("skills/first-tree/");
    expect(read("README.md")).toContain(".agents/skills/first-tree/");
    expect(read("README.md")).toContain(".claude/skills/first-tree/");
    expect(read("README.md")).toContain("four skill payloads");
    expect(read("README.md")).toContain("maintenance namespace");
    expect(read("README.md")).toContain("dedicated tree repo");
    expect(read("README.md")).toContain("first-tree tree inspect");
    expect(read("README.md")).toContain("first-tree tree bind");
    expect(read("README.md")).toContain("first-tree tree workspace sync");
    expect(read("README.md")).toContain(".first-tree/source.json");
    expect(read("README.md")).toContain(".first-tree/tree.json");
    expect(read("README.md")).toContain(".first-tree/bindings/");
    expect(read("README.md")).toContain("source-repos.md");
    expect(read("README.md")).not.toContain(".first-tree/submodules/");
    expect(read("README.md")).toContain("`first-tree` skill");
    expect(read("README.md")).toContain("first-tree tree publish");
    expect(read("README.md")).toContain("<repo>-tree");
    expect(read("README.md")).toContain("shared tree");
    expect(read("README.md")).toContain("first-tree tree bootstrap --here");
    expect(read("README.md")).toContain("npx first-tree tree init");
    expect(read("README.md")).toContain("npx first-tree <namespace> <command>");
    expect(read("AGENTS.md")).toContain("docs/source-map.md");
    expect(read("AGENTS.md")).toContain("maintenance namespace");
    expect(read("AGENTS.md")).toContain("source-workspace-installation.md");
    expect(read("AGENTS.md")).toContain("first-tree-skill-cli/");
    expect(read("AGENTS.md")).toContain("entry-point skill payload");
    expect(read("AGENTS.md")).not.toContain("### Running evals");
    expect(read("AGENTS.md")).not.toContain("EVALS_TREE_REPO");
    expect(read("src/cli.ts")).not.toContain("from upstream");
    // Note: #evals/* import alias is in package.json but evals/ is excluded from "files" so it won't ship to npm

    const onboarding = read("skills/first-tree/references/onboarding.md");
    expect(onboarding).toContain("Node.js 18+");
    expect(onboarding).toContain("first-tree tree inspect --json");
    expect(onboarding).toContain("first-tree tree bind");
    expect(onboarding).toContain("first-tree tree workspace sync");
    expect(onboarding).toContain("baseline coverage");
    expect(onboarding).toContain("source/workspace root");
    expect(onboarding).toContain(".first-tree/tmp/");
    expect(onboarding).toContain(".first-tree/source.json");
    expect(onboarding).toContain(".first-tree/tree.json");
    expect(onboarding).toContain(".first-tree/bindings/");
    expect(onboarding).toContain("source-repos.md");
    expect(onboarding).not.toContain(".first-tree/submodules/");
    expect(onboarding).toContain("<repo>-tree");
    expect(onboarding).toContain("first-tree tree bootstrap --here");
    expect(onboarding).toContain("shared tree");
    expect(onboarding).not.toContain("This clones the framework into `.context-tree/`");
    expect(onboarding).not.toContain("from upstream");

    const firstTreeSkillMd = read("skills/first-tree/SKILL.md");
    const treeSkillMd = read("skills/tree/SKILL.md");
    // Skill payloads are user-facing: shipped to user repos via
    // copyCanonicalSkill. They must NOT mention engine/, assets/, tests/,
    // scripts/, maintainer-* docs, or anything that doesn't exist in the
    // lightweight installed payload.
    for (const skillMd of [firstTreeSkillMd, treeSkillMd]) {
      expect(skillMd).not.toContain("sync-skill-artifacts.sh");
      expect(skillMd).not.toContain("portable-smoke-test.sh");
      expect(skillMd).not.toContain("docs/build/distribution.md");
      expect(skillMd).not.toContain("docs/testing/overview.md");
      expect(skillMd).not.toContain("docs/architecture/overview.md");
      expect(skillMd).not.toContain("source-map.md");
      expect(skillMd).not.toContain("canonical eval harness");
      expect(skillMd).not.toContain("`engine/`");
      expect(skillMd).not.toContain("`tests/`");
      expect(skillMd).not.toContain("`scripts/`");
      expect(skillMd).not.toContain(".first-tree/submodules/");
    }
    // first-tree is the entry-point skill: methodology, routing, install,
    // and skill management.
    expect(firstTreeSkillMd).toContain("Context Tree");
    expect(firstTreeSkillMd).toContain("Before Every Task");
    expect(firstTreeSkillMd).toContain("After Every Task");
    expect(firstTreeSkillMd).toContain("npx first-tree <namespace> <command>");
    expect(firstTreeSkillMd).toContain("npx -p first-tree first-tree <namespace> <command>");
    expect(firstTreeSkillMd).toContain("first-tree skill install");
    expect(firstTreeSkillMd).toContain("first-tree skill upgrade");
    expect(firstTreeSkillMd).toContain("--skip-version-check");
    expect(firstTreeSkillMd).toContain("references/principles.md");
    expect(firstTreeSkillMd).toContain("references/ownership-and-naming.md");
    // tree is the operational handbook for `first-tree tree` commands.
    expect(treeSkillMd).toContain("first-tree tree inspect");
    expect(treeSkillMd).toContain("first-tree tree init");
    expect(treeSkillMd).toContain("first-tree tree bootstrap");
    expect(treeSkillMd).toContain("first-tree tree bind");
    expect(treeSkillMd).toContain("first-tree tree workspace sync");
    expect(treeSkillMd).toContain("first-tree tree verify");
    expect(treeSkillMd).toContain("first-tree tree upgrade");
    expect(treeSkillMd).toContain("first-tree tree publish");

    const sourceMap = read("docs/source-map.md");
    expect(sourceMap).not.toContain("repo-snapshot");
    expect(sourceMap).not.toContain("sync-skill-artifacts.sh");
    expect(sourceMap).toContain("first-tree-skill-cli/repo-architecture.md");
    expect(sourceMap).toContain("products (`tree`, `breeze`, `gardener`) plus maintenance (`skill`)");
    expect(sourceMap).toContain("first-tree-skill-cli/thin-cli-shell.md");
    expect(sourceMap).toContain("first-tree-skill-cli/build-and-distribution.md");
    expect(sourceMap).toContain("first-tree-skill-cli/validation-surface.md");
    expect(sourceMap).toContain("first-tree-skill-cli/sync.md");
    expect(sourceMap).toContain("source-workspace-installation.md");
    expect(sourceMap).toContain("docs/design/sync.md");
    expect(sourceMap).toContain("docs/architecture/overview.md");
    expect(sourceMap).toContain("docs/architecture/thin-cli.md");
    expect(sourceMap).toContain("docs/build/distribution.md");
    expect(sourceMap).toContain("docs/testing/overview.md");
    expect(sourceMap).toContain("src/products/tree/engine/publish.ts");
    expect(sourceMap).toContain("src/products/tree/engine/sync.ts");
    expect(sourceMap).toContain("src/products/tree/engine/inspect.ts");
    expect(sourceMap).toContain("src/products/tree/engine/bind.ts");
    expect(sourceMap).toContain("src/products/tree/engine/workspace-sync.ts");
    expect(sourceMap).toContain("tests/tree/publish.test.ts");
    expect(sourceMap).toContain("tests/tree/sync.test.ts");
    expect(sourceMap).toContain("src/products/tree/engine/runtime/binding-state.ts");
    expect(sourceMap).toContain("src/products/tree/engine/runtime/local-tree-config.ts"); // still exists, delegates to source.json
    expect(sourceMap).toContain("src/products/tree/engine/runtime/source-repo-index.ts");
    expect(sourceMap).toContain("tests/tree/init.test.ts");
    expect(sourceMap).toContain("tests/e2e/thin-cli.test.ts");
    expect(sourceMap).not.toContain("evals/first-tree-eval.test.ts");

    const sourceWorkspaceInstall = read(
      "skills/first-tree/references/source-workspace-installation.md",
    );
    expect(sourceWorkspaceInstall).toContain("FIRST-TREE-SOURCE-INTEGRATION:");
    expect(sourceWorkspaceInstall).toContain(".first-tree/source.json");
    expect(sourceWorkspaceInstall).toContain(".first-tree/tree.json");
    expect(sourceWorkspaceInstall).toContain(".first-tree/bindings/");
    expect(sourceWorkspaceInstall).toContain("source-repos.md");
    expect(sourceWorkspaceInstall).not.toContain(".first-tree/submodules/");
    expect(sourceWorkspaceInstall).toContain("workspace-member");
    expect(sourceWorkspaceInstall).toContain("first-tree tree workspace sync");
    expect(sourceWorkspaceInstall).toContain("first-tree skill upgrade");
    expect(sourceWorkspaceInstall).toContain("first-tree tree publish");
    expect(sourceWorkspaceInstall).toContain("<repo>-tree");
    expect(sourceWorkspaceInstall).toContain("Do not recreate a new sibling tree repo");

    const openaiPrompt = read("agents/openai.yaml");
    expect(openaiPrompt).toContain("first-tree tree inspect --json");
    expect(openaiPrompt).toContain("first-tree tree bind");
    expect(openaiPrompt).toContain("first-tree tree workspace sync");
    expect(openaiPrompt).toContain("baseline coverage");
    expect(openaiPrompt).toContain("progress.md");
    expect(openaiPrompt).toContain(".first-tree/source.json");
    expect(openaiPrompt).toContain("source-repos.md");

    const maintainerArchitecture = read(
      "docs/architecture/overview.md",
    );
    expect(maintainerArchitecture).toContain("first-tree-skill-cli/repo-architecture.md");
    expect(maintainerArchitecture).toContain("skills/first-tree/");
    expect(maintainerArchitecture).toContain("assets/tree/");
    expect(maintainerArchitecture).toContain("src/products/tree/engine/");
    expect(maintainerArchitecture).toContain("tests/");
    expect(maintainerArchitecture).toContain(".first-tree/bindings/");
    expect(maintainerArchitecture).toContain("source-repos.md");
    expect(maintainerArchitecture).not.toContain(".first-tree/submodules/");

    const upgradeContract = read(
      "skills/first-tree/references/upgrade-contract.md",
    );
    expect(upgradeContract).not.toContain(".first-tree/submodules/");

    const buildAndDistribution = read(
      "docs/build/distribution.md",
    );
    expect(buildAndDistribution).toContain("first-tree-skill-cli/build-and-distribution.md");
    expect(buildAndDistribution).toContain("pnpm pack");
    expect(buildAndDistribution).toContain("assets/tree/VERSION");

    const designSync = read("docs/design/sync.md");
    expect(designSync).toContain("first-tree-skill-cli/sync.md");
    expect(designSync).toContain("src/products/tree/engine/sync.ts");
    expect(designSync).toContain("tests/tree/sync.test.ts");
  });

  it("keeps public OSS entrypoints and package metadata in place", () => {
    const read = (path: string) => readFileSync(join(ROOT, path), "utf-8");
    const pkg = JSON.parse(read("package.json")) as {
      homepage?: string;
      bugs?: { url?: string };
      repository?: { type?: string; url?: string };
      keywords?: string[];
    };

    expect(read("README.md")).toContain("Package And Command");
    expect(read("README.md")).toContain("CONTRIBUTING.md");
    expect(read("README.md")).toContain("CODE_OF_CONDUCT.md");
    expect(read("README.md")).toContain("SECURITY.md");

    expect(read("CONTRIBUTING.md")).toContain("pnpm validate:skill");
    expect(read("CONTRIBUTING.md")).toContain("pull request template");
    expect(read("CONTRIBUTING.md")).toContain("source-map.md");
    expect(read("CODE_OF_CONDUCT.md")).toContain("private maintainer follow-up");
    expect(read("SECURITY.md")).toContain("Private Vulnerability Reporting");
    expect(read("SECURITY.md")).toContain("do not post exploit details");

    expect(existsSync(join(ROOT, ".github", "PULL_REQUEST_TEMPLATE.md"))).toBe(true);

    const bugTemplate = parse(read(".github/ISSUE_TEMPLATE/bug-report.yml")) as {
      name?: string;
      body?: unknown[];
    };
    const featureTemplate = parse(read(".github/ISSUE_TEMPLATE/feature-request.yml")) as {
      name?: string;
      body?: unknown[];
    };
    const issueConfig = parse(read(".github/ISSUE_TEMPLATE/config.yml")) as {
      contact_links?: unknown[];
    };

    expect(bugTemplate.name).toBe("Bug report");
    expect(Array.isArray(bugTemplate.body)).toBe(true);
    expect(featureTemplate.name).toBe("Feature request");
    expect(Array.isArray(featureTemplate.body)).toBe(true);
    expect(Array.isArray(issueConfig.contact_links)).toBe(true);
    expect(issueConfig.contact_links).toHaveLength(3);

    expect(pkg.homepage).toBe("https://github.com/agent-team-foundation/first-tree#readme");
    expect(pkg.bugs).toEqual({
      url: "https://github.com/agent-team-foundation/first-tree/issues",
    });
    expect(pkg.repository).toEqual({
      type: "git",
      url: "git+https://github.com/agent-team-foundation/first-tree.git",
    });
    expect(pkg.keywords).toEqual(
      expect.arrayContaining(["first-tree", "cli", "agents"]),
    );
  });
});
