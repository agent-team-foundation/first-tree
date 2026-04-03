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
    expect(existsSync(join(ROOT, ".agents"))).toBe(false);
    expect(existsSync(join(ROOT, ".claude"))).toBe(false);
    expect(existsSync(join(ROOT, ".context-tree"))).toBe(false);
    expect(existsSync(join(ROOT, "docs"))).toBe(false);
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

    const onboarding = read("skills/first-tree-cli-framework/references/onboarding.md");
    expect(onboarding).toContain("npx first-tree init");
    expect(onboarding).toContain("npm install -g first-tree");
    expect(onboarding).not.toContain("This clones the framework into `.context-tree/`");

    const skillMd = read("skills/first-tree-cli-framework/SKILL.md");
    expect(skillMd).not.toContain("sync-skill-artifacts.sh");
    expect(skillMd).not.toContain("portable-smoke-test.sh");

    const sourceMap = read("skills/first-tree-cli-framework/references/source-map.md");
    expect(sourceMap).not.toContain("repo-snapshot");
    expect(sourceMap).not.toContain("sync-skill-artifacts.sh");
  });
});
