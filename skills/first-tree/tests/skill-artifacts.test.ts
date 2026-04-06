import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = process.cwd();

/** Check if a path has any tracked files in git (handles dirs and files). */
function isTrackedInGit(relativePath: string): boolean {
  const result = spawnSync("git", ["ls-files", relativePath], {
    cwd: ROOT,
    stdio: "pipe",
  });
  return (result.stdout?.toString().trim().length ?? 0) > 0;
}

describe("skill artifacts", () => {
  it("keeps only the canonical skill in the source repo", () => {
    expect(existsSync(join(ROOT, "skills", "first-tree", "SKILL.md"))).toBe(true);
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
    expect(existsSync(join(ROOT, "skills", "first-tree", "assets", "framework", "manifest.json"))).toBe(true);
    expect(existsSync(join(ROOT, "skills", "first-tree", "assets", "framework", "templates", "claude.md.template"))).toBe(true);
    expect(existsSync(join(ROOT, "skills", "first-tree", "engine", "init.ts"))).toBe(true);
    expect(
      existsSync(join(ROOT, "skills", "first-tree", "engine", "member-seeding.ts")),
    ).toBe(true);
    expect(existsSync(join(ROOT, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(ROOT, "skills", "first-tree", "tests", "init.test.ts"))).toBe(
      true,
    );
    expect(
      existsSync(join(ROOT, "skills", "first-tree", "tests", "member-seeding.test.ts")),
    ).toBe(true);
    expect(
      existsSync(
        join(ROOT, "evals", "first-tree-eval.test.ts"),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(
          ROOT,
          "skills",
          "first-tree",
          "engine",
          "runtime",
          "asset-loader.ts",
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(
          ROOT,
          "skills",
          "first-tree",
          "engine",
          "runtime",
          "source-integration.ts",
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(
          ROOT,
          "skills",
          "first-tree",
          "engine",
          "rules",
          "index.ts",
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(
          ROOT,
          "skills",
          "first-tree",
          "engine",
          "validators",
          "nodes.ts",
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(
          ROOT,
          "skills",
          "first-tree",
          "references",
          "maintainer-architecture.md",
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(
          ROOT,
          "skills",
          "first-tree",
          "references",
          "maintainer-thin-cli.md",
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(
          ROOT,
          "skills",
          "first-tree",
          "references",
          "maintainer-build-and-distribution.md",
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(
          ROOT,
          "skills",
          "first-tree",
          "references",
          "maintainer-testing.md",
        ),
      ),
    ).toBe(true);
    // Legacy artifacts must not be tracked in git (untracked local files are OK)
    expect(isTrackedInGit(".agents")).toBe(false);
    expect(isTrackedInGit(".claude")).toBe(false);
    expect(isTrackedInGit(".context-tree")).toBe(false);
    expect(existsSync(join(ROOT, "AGENT.md"))).toBe(false);
    expect(isTrackedInGit("docs")).toBe(false);
    expect(isTrackedInGit("tests")).toBe(false);
    expect(existsSync(join(ROOT, "evals"))).toBe(true);
    expect(existsSync(join(ROOT, "src", "commands"))).toBe(false);
    expect(existsSync(join(ROOT, "src", "runtime"))).toBe(false);
    expect(existsSync(join(ROOT, "src", "rules"))).toBe(false);
    expect(existsSync(join(ROOT, "src", "validators"))).toBe(false);
    expect(existsSync(join(ROOT, "src", "init.ts"))).toBe(false);
    expect(existsSync(join(ROOT, "src", "verify.ts"))).toBe(false);
    expect(existsSync(join(ROOT, "src", "upgrade.ts"))).toBe(false);
    expect(existsSync(join(ROOT, "src", "repo.ts"))).toBe(false);
    expect(existsSync(join(ROOT, "src", "onboarding.ts"))).toBe(false);
    expect(
      existsSync(join(ROOT, "skills", "first-tree", "references", "repo-snapshot")),
    ).toBe(false);
    expect(existsSync(join(ROOT, "skills", "first-tree", "evals"))).toBe(false);
  });

  it("passes skill validation helpers", () => {
    execFileSync(
      "python3",
      ["./skills/first-tree/scripts/quick_validate.py", "./skills/first-tree"],
      {
        cwd: ROOT,
        stdio: "pipe",
        encoding: "utf-8",
      },
    );
    execFileSync("bash", ["./skills/first-tree/scripts/check-skill-sync.sh"], {
      cwd: ROOT,
      stdio: "pipe",
      encoding: "utf-8",
    });
  });

  it("ships the canonical skill in the published tarball", () => {
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
      expect(listing).toContain("package/skills/first-tree/SKILL.md");
      expect(listing).toContain(
        "package/skills/first-tree/agents/openai.yaml",
      );
      expect(listing).toContain(
        "package/skills/first-tree/engine/init.ts",
      );
      expect(listing).toContain(
        "package/skills/first-tree/engine/member-seeding.ts",
      );
      expect(listing).toContain(
        "package/skills/first-tree/assets/framework/templates/claude.md.template",
        "package/skills/first-tree/assets/framework/helpers/summarize-progress.js",
      );
      expect(listing).toContain(
        "package/skills/first-tree/tests/init.test.ts",
      );
      expect(listing).toContain(
        "package/skills/first-tree/tests/member-seeding.test.ts",
      );
      expect(listing).not.toContain("package/skills/first-tree/evals/");
      expect(listing).not.toContain("package/evals/");
      expect(listing).not.toContain("package/src/cli.ts");
      expect(listing).not.toContain("package/docs/");
    } finally {
      rmSync(packDir, { recursive: true, force: true });
    }
  });

  it("keeps naming and installation guidance aligned", () => {
    const read = (path: string) => readFileSync(join(ROOT, path), "utf-8");

    expect(read("README.md")).not.toContain("seed-tree");
    expect(read("AGENTS.md")).not.toContain("seed-tree");
    expect(read("README.md")).toContain("Package And Command");
    expect(read("README.md")).toContain("Canonical Documentation");
    expect(read("README.md")).toContain("references/source-map.md");
    expect(read("README.md")).toContain("source-workspace-installation.md");
    expect(read("README.md")).toContain("skills/first-tree/");
    expect(read("README.md")).toContain(".agents/skills/first-tree/");
    expect(read("README.md")).toContain(".claude/skills/first-tree/");
    expect(read("README.md")).toContain("bundled canonical");
    expect(read("README.md")).toContain("dedicated tree repo");
    expect(read("README.md")).toContain("FIRST-TREE-SOURCE-INTEGRATION:");
    expect(read("README.md")).toContain("`first-tree` skill");
    expect(read("README.md")).toContain("first-tree publish --open-pr");
    expect(read("README.md")).toContain("canonical local working copy");
    expect(read("README.md")).toContain("<repo>-tree");
    expect(read("README.md")).toContain("*-context` repos are still reused");
    expect(read("README.md")).toContain("Only use `--here` after you have already switched into the dedicated tree repo.");
    expect(read("AGENTS.md")).toContain("references/source-map.md");
    expect(read("AGENTS.md")).toContain("source-workspace-installation.md");
    expect(read("AGENTS.md")).toContain("bundled skill path");
    expect(read("AGENTS.md")).not.toContain("### Running evals");
    expect(read("AGENTS.md")).not.toContain("EVALS_TREE_REPO");
    expect(read("src/cli.ts")).not.toContain("from upstream");
    // Note: #evals/* import alias is in package.json but evals/ is excluded from "files" so it won't ship to npm

    const onboarding = read("skills/first-tree/references/onboarding.md");
    expect(onboarding).toContain("npx first-tree init");
    expect(onboarding).toContain("npm install -g first-tree");
    expect(onboarding).toContain("first-tree init --here");
    expect(onboarding).toContain("installed CLI command are both `first-tree`");
    expect(onboarding).toContain("currently running `first-tree` npm package");
    expect(onboarding).toContain("npx first-tree@latest upgrade");
    expect(onboarding).toContain(".agents/skills/first-tree/");
    expect(onboarding).toContain(".claude/skills/first-tree/");
    expect(onboarding).toContain("FIRST-TREE-SOURCE-INTEGRATION:");
    expect(onboarding).toContain("first-tree publish --open-pr");
    expect(onboarding).toContain("baseline coverage");
    expect(onboarding).toContain("summarize-progress.js");
    expect(onboarding).toContain("source/workspace repo");
    expect(onboarding).toContain("git submodule");
    expect(onboarding).toContain("<repo>-tree");
    expect(onboarding).toContain("dedicated `*-context`");
    expect(onboarding).toContain("supported and reused when already bound");
    expect(onboarding).toContain("Only use `--here` after you have already switched into the dedicated tree repo.");
    expect(onboarding).not.toContain("This clones the framework into `.context-tree/`");
    expect(onboarding).not.toContain("from upstream");

    const skillMd = read("skills/first-tree/SKILL.md");
    expect(skillMd).not.toContain("sync-skill-artifacts.sh");
    expect(skillMd).not.toContain("portable-smoke-test.sh");
    expect(skillMd).toContain("maintainer-build-and-distribution.md");
    expect(skillMd).toContain("maintainer-testing.md");
    expect(skillMd).toContain("currently running `first-tree` package");
    expect(skillMd).toContain("command examples stay aligned with the published package");
    expect(skillMd).toContain(".agents/skills/first-tree/");
    expect(skillMd).toContain(".claude/skills/first-tree/");
    expect(skillMd).toContain("source-workspace-installation.md");
    expect(skillMd).toContain("baseline coverage");
    expect(skillMd).toContain("summarize-progress.js");
    expect(skillMd).toContain("FIRST-TREE-SOURCE-INTEGRATION:");
    expect(skillMd).toContain("first-tree publish --open-pr");
    expect(skillMd).toContain("<repo>-tree");
    expect(skillMd).toContain("older dedicated `*-context` repo");
    expect(skillMd).toContain("Never run `first-tree init --here` in a source/workspace repo");
    expect(skillMd).not.toContain("canonical eval harness");

    const sourceMap = read("skills/first-tree/references/source-map.md");
    expect(sourceMap).not.toContain("repo-snapshot");
    expect(sourceMap).not.toContain("sync-skill-artifacts.sh");
    expect(sourceMap).toContain("source-workspace-installation.md");
    expect(sourceMap).toContain("maintainer-architecture.md");
    expect(sourceMap).toContain("maintainer-thin-cli.md");
    expect(sourceMap).toContain("maintainer-build-and-distribution.md");
    expect(sourceMap).toContain("maintainer-testing.md");
    expect(sourceMap).toContain("engine/publish.ts");
    expect(sourceMap).toContain("tests/publish.test.ts");
    expect(sourceMap).toContain("engine/commands/");
    expect(sourceMap).toContain("engine/runtime/asset-loader.ts");
    expect(sourceMap).toContain("summarize-progress.js");
    expect(sourceMap).toContain("tests/init.test.ts");
    expect(sourceMap).toContain("tests/thin-cli.test.ts");
    expect(sourceMap).not.toContain("evals/first-tree-eval.test.ts");
    expect(sourceMap).toContain("package.json");
    expect(sourceMap).not.toContain("vitest.eval.config.ts");
    expect(sourceMap).toContain(".github/workflows/ci.yml");

    const sourceWorkspaceInstall = read(
      "skills/first-tree/references/source-workspace-installation.md",
    );
    expect(sourceWorkspaceInstall).toContain("FIRST-TREE-SOURCE-INTEGRATION:");
    expect(sourceWorkspaceInstall).toContain("baseline coverage");
    expect(sourceWorkspaceInstall).toContain("git submodule");
    expect(sourceWorkspaceInstall).toContain("top-level domain");
    expect(sourceWorkspaceInstall).toContain("first-tree publish --open-pr");
    expect(sourceWorkspaceInstall).toContain("<repo>-tree");
    expect(sourceWorkspaceInstall).toContain("legacy `*-context` repo");
    expect(sourceWorkspaceInstall).toContain("Do not run `first-tree verify`");
    expect(sourceWorkspaceInstall).toContain("Do not run `first-tree init --here` in the source/workspace repo");

    const openaiPrompt = read("skills/first-tree/agents/openai.yaml");
    expect(openaiPrompt).toContain("baseline coverage");
    expect(openaiPrompt).toContain("top-level domain");
    expect(openaiPrompt).toContain("progress.md");

    const maintainerArchitecture = read(
      "skills/first-tree/references/maintainer-architecture.md",
    );
    expect(maintainerArchitecture).toContain("maintainer-only developer tooling");
    expect(maintainerArchitecture).toContain("`evals/`");
    expect(maintainerArchitecture).not.toContain("tests, and evals");

    const buildAndDistribution = read(
      "skills/first-tree/references/maintainer-build-and-distribution.md",
    );
    expect(buildAndDistribution).toContain("first-tree publish");
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
