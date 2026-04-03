import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

describe("skill artifacts", () => {
  it("keeps only the canonical skill in the source repo", () => {
    expect(existsSync(join(ROOT, "skills", "first-tree-cli-framework", "SKILL.md"))).toBe(true);
    expect(existsSync(join(ROOT, "skills", "first-tree-cli-framework", "references", "onboarding.md"))).toBe(true);
    expect(existsSync(join(ROOT, "skills", "first-tree-cli-framework", "assets", "framework", "manifest.json"))).toBe(true);
    expect(existsSync(join(ROOT, "skills", "first-tree-cli-framework", "engine", "init.ts"))).toBe(true);
    expect(existsSync(join(ROOT, "skills", "first-tree-cli-framework", "tests", "init.test.ts"))).toBe(
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
          "first-tree-cli-framework",
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
          "first-tree-cli-framework",
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
          "first-tree-cli-framework",
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
          "first-tree-cli-framework",
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
          "first-tree-cli-framework",
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
          "first-tree-cli-framework",
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
          "first-tree-cli-framework",
          "references",
          "maintainer-testing.md",
        ),
      ),
    ).toBe(true);
    expect(existsSync(join(ROOT, ".agents"))).toBe(false);
    expect(existsSync(join(ROOT, ".claude"))).toBe(false);
    expect(existsSync(join(ROOT, ".context-tree"))).toBe(false);
    expect(existsSync(join(ROOT, "docs"))).toBe(false);
    expect(existsSync(join(ROOT, "tests"))).toBe(false);
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
      existsSync(join(ROOT, "skills", "first-tree-cli-framework", "references", "repo-snapshot")),
    ).toBe(false);
    expect(existsSync(join(ROOT, "skills", "first-tree-cli-framework", "evals"))).toBe(false);
  });

  it("passes skill validation helpers", () => {
    execFileSync(
      "python3",
      ["./skills/first-tree-cli-framework/scripts/quick_validate.py", "./skills/first-tree-cli-framework"],
      {
        cwd: ROOT,
        stdio: "pipe",
        encoding: "utf-8",
      },
    );
    execFileSync("bash", ["./skills/first-tree-cli-framework/scripts/check-skill-sync.sh"], {
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
      expect(listing).toContain("package/skills/first-tree-cli-framework/SKILL.md");
      expect(listing).toContain(
        "package/skills/first-tree-cli-framework/agents/openai.yaml",
      );
      expect(listing).toContain(
        "package/skills/first-tree-cli-framework/engine/init.ts",
      );
      expect(listing).toContain(
        "package/skills/first-tree-cli-framework/tests/init.test.ts",
      );
      expect(listing).not.toContain("package/skills/first-tree-cli-framework/evals/");
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
    expect(read("README.md")).toContain("Canonical Documentation");
    expect(read("README.md")).toContain("references/source-map.md");
    expect(read("README.md")).toContain("bundled skill");
    expect(read("AGENTS.md")).toContain("references/source-map.md");
    expect(read("AGENTS.md")).not.toContain("### Running evals");
    expect(read("AGENTS.md")).not.toContain("EVALS_TREE_REPO");
    expect(read("src/cli.ts")).not.toContain("from upstream");
    expect(read("package.json")).not.toContain('"#evals/*"');

    const onboarding = read("skills/first-tree-cli-framework/references/onboarding.md");
    expect(onboarding).toContain("npx first-tree init");
    expect(onboarding).toContain("npm install -g first-tree");
    expect(onboarding).toContain("currently running `first-tree` package");
    expect(onboarding).toContain("npx first-tree@latest upgrade");
    expect(onboarding).not.toContain("This clones the framework into `.context-tree/`");
    expect(onboarding).not.toContain("from upstream");

    const skillMd = read("skills/first-tree-cli-framework/SKILL.md");
    expect(skillMd).not.toContain("sync-skill-artifacts.sh");
    expect(skillMd).not.toContain("portable-smoke-test.sh");
    expect(skillMd).toContain("maintainer-build-and-distribution.md");
    expect(skillMd).toContain("maintainer-testing.md");
    expect(skillMd).toContain("currently running `first-tree` package");
    expect(skillMd).not.toContain("canonical eval harness");

    const sourceMap = read("skills/first-tree-cli-framework/references/source-map.md");
    expect(sourceMap).not.toContain("repo-snapshot");
    expect(sourceMap).not.toContain("sync-skill-artifacts.sh");
    expect(sourceMap).toContain("maintainer-architecture.md");
    expect(sourceMap).toContain("maintainer-thin-cli.md");
    expect(sourceMap).toContain("maintainer-build-and-distribution.md");
    expect(sourceMap).toContain("maintainer-testing.md");
    expect(sourceMap).toContain("engine/commands/");
    expect(sourceMap).toContain("engine/runtime/asset-loader.ts");
    expect(sourceMap).toContain("tests/init.test.ts");
    expect(sourceMap).not.toContain("evals/context-tree-eval.test.ts");
    expect(sourceMap).toContain("package.json");
    expect(sourceMap).not.toContain("vitest.eval.config.ts");
    expect(sourceMap).toContain(".github/workflows/ci.yml");

    const maintainerArchitecture = read(
      "skills/first-tree-cli-framework/references/maintainer-architecture.md",
    );
    expect(maintainerArchitecture).toContain("maintainer-only developer tooling");
    expect(maintainerArchitecture).toContain("`evals/`");
    expect(maintainerArchitecture).not.toContain("tests, and evals");
  });
});
