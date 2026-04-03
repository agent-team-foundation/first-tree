import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

describe("skill artifacts", () => {
  it("keeps only the canonical skill in the source repo", () => {
    expect(existsSync(join(ROOT, "skills", "first-tree-cli-framework", "SKILL.md"))).toBe(true);
    expect(existsSync(join(ROOT, "skills", "first-tree-cli-framework", "references", "onboarding.md"))).toBe(true);
    expect(existsSync(join(ROOT, "skills", "first-tree-cli-framework", "assets", "framework", "manifest.json"))).toBe(true);
    expect(existsSync(join(ROOT, "skills", "first-tree-cli-framework", "engine", "init.ts"))).toBe(true);
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
          "maintainer-testing-and-evals.md",
        ),
      ),
    ).toBe(true);
    expect(existsSync(join(ROOT, ".agents"))).toBe(false);
    expect(existsSync(join(ROOT, ".claude"))).toBe(false);
    expect(existsSync(join(ROOT, ".context-tree"))).toBe(false);
    expect(existsSync(join(ROOT, "docs"))).toBe(false);
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

  it("keeps naming and installation guidance aligned", () => {
    const read = (path: string) => readFileSync(join(ROOT, path), "utf-8");

    expect(read("README.md")).not.toContain("seed-tree");
    expect(read("AGENTS.md")).not.toContain("seed-tree");
    expect(read("README.md")).toContain("Canonical Documentation");
    expect(read("README.md")).toContain("references/source-map.md");
    expect(read("AGENTS.md")).toContain("references/source-map.md");
    expect(read("AGENTS.md")).not.toContain("### Running evals");
    expect(read("AGENTS.md")).not.toContain("EVALS_TREE_REPO");

    const onboarding = read("skills/first-tree-cli-framework/references/onboarding.md");
    expect(onboarding).toContain("npx first-tree init");
    expect(onboarding).toContain("npm install -g first-tree");
    expect(onboarding).not.toContain("This clones the framework into `.context-tree/`");

    const skillMd = read("skills/first-tree-cli-framework/SKILL.md");
    expect(skillMd).not.toContain("sync-skill-artifacts.sh");
    expect(skillMd).not.toContain("portable-smoke-test.sh");
    expect(skillMd).toContain("maintainer-build-and-distribution.md");
    expect(skillMd).toContain("maintainer-testing-and-evals.md");

    const sourceMap = read("skills/first-tree-cli-framework/references/source-map.md");
    expect(sourceMap).not.toContain("repo-snapshot");
    expect(sourceMap).not.toContain("sync-skill-artifacts.sh");
    expect(sourceMap).toContain("maintainer-architecture.md");
    expect(sourceMap).toContain("maintainer-thin-cli.md");
    expect(sourceMap).toContain("maintainer-build-and-distribution.md");
    expect(sourceMap).toContain("maintainer-testing-and-evals.md");
    expect(sourceMap).toContain("engine/commands/");
    expect(sourceMap).toContain("engine/runtime/asset-loader.ts");
    expect(sourceMap).toContain("package.json");
    expect(sourceMap).toContain("vitest.eval.config.ts");
    expect(sourceMap).toContain(".github/workflows/ci.yml");
  });
});
