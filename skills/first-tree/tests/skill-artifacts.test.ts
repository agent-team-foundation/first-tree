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
    expect(existsSync(join(ROOT, "skills", "first-tree", "assets", "framework", "manifest.json"))).toBe(true);
    expect(existsSync(join(ROOT, "skills", "first-tree", "engine", "init.ts"))).toBe(true);
    expect(existsSync(join(ROOT, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(ROOT, "skills", "first-tree", "tests", "init.test.ts"))).toBe(
      true,
    );
    expect(
      existsSync(
        join(ROOT, "evals", "context-tree-eval.test.ts"),
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
    expect(isTrackedInGit("skills/first-tree-cli-framework")).toBe(false);
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
        "package/skills/first-tree/tests/init.test.ts",
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
    expect(read("README.md")).toContain("Package Name vs Command");
    expect(read("README.md")).toContain("Canonical Documentation");
    expect(read("README.md")).toContain("references/source-map.md");
    expect(read("README.md")).toContain("skills/first-tree/");
    expect(read("README.md")).toContain("bundled canonical");
    expect(read("README.md")).toContain("dedicated tree repo");
    expect(read("README.md")).toContain("`first-tree` skill");
    expect(read("AGENTS.md")).toContain("references/source-map.md");
    expect(read("AGENTS.md")).toContain("bundled skill path");
    expect(read("AGENTS.md")).not.toContain("### Running evals");
    expect(read("AGENTS.md")).not.toContain("EVALS_TREE_REPO");
    expect(read("src/cli.ts")).not.toContain("from upstream");
    // Note: #evals/* import alias is in package.json but evals/ is excluded from "files" so it won't ship to npm

    const onboarding = read("skills/first-tree/references/onboarding.md");
    expect(onboarding).toContain("npx first-tree init");
    expect(onboarding).toContain("npm install -g first-tree");
    expect(onboarding).toContain("context-tree init --here");
    expect(onboarding).toContain("installed CLI command is");
    expect(onboarding).toContain("currently running `first-tree` npm package");
    expect(onboarding).toContain("npx first-tree@latest upgrade");
    expect(onboarding).not.toContain("This clones the framework into `.context-tree/`");
    expect(onboarding).not.toContain("from upstream");

    const skillMd = read("skills/first-tree/SKILL.md");
    expect(skillMd).not.toContain("sync-skill-artifacts.sh");
    expect(skillMd).not.toContain("portable-smoke-test.sh");
    expect(skillMd).toContain("maintainer-build-and-distribution.md");
    expect(skillMd).toContain("maintainer-testing.md");
    expect(skillMd).toContain("currently running `first-tree` package");
    expect(skillMd).toContain("so it is not confused with the `first-tree`");
    expect(skillMd).not.toContain("canonical eval harness");

    const sourceMap = read("skills/first-tree/references/source-map.md");
    expect(sourceMap).not.toContain("repo-snapshot");
    expect(sourceMap).not.toContain("sync-skill-artifacts.sh");
    expect(sourceMap).toContain("maintainer-architecture.md");
    expect(sourceMap).toContain("maintainer-thin-cli.md");
    expect(sourceMap).toContain("maintainer-build-and-distribution.md");
    expect(sourceMap).toContain("maintainer-testing.md");
    expect(sourceMap).toContain("engine/commands/");
    expect(sourceMap).toContain("engine/runtime/asset-loader.ts");
    expect(sourceMap).toContain("tests/init.test.ts");
    expect(sourceMap).toContain("tests/thin-cli.test.ts");
    expect(sourceMap).not.toContain("evals/context-tree-eval.test.ts");
    expect(sourceMap).toContain("package.json");
    expect(sourceMap).not.toContain("vitest.eval.config.ts");
    expect(sourceMap).toContain(".github/workflows/ci.yml");

    const maintainerArchitecture = read(
      "skills/first-tree/references/maintainer-architecture.md",
    );
    expect(maintainerArchitecture).toContain("maintainer-only developer tooling");
    expect(maintainerArchitecture).toContain("`evals/`");
    expect(maintainerArchitecture).not.toContain("tests, and evals");
  });

  it("keeps public OSS entrypoints and package metadata in place", () => {
    const read = (path: string) => readFileSync(join(ROOT, path), "utf-8");
    const pkg = JSON.parse(read("package.json")) as {
      homepage?: string;
      bugs?: { url?: string };
      repository?: { type?: string; url?: string };
      keywords?: string[];
    };

    expect(read("README.md")).toContain("Package Name vs Command");
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
      expect.arrayContaining(["context-tree", "cli", "agents"]),
    );
  });
});
