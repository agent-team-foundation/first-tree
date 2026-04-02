import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

describe("skill artifacts", () => {
  it("keeps the source-of-truth skill and generated mirrors present", () => {
    expect(existsSync(join(ROOT, "skills", "first-tree-cli-framework", "SKILL.md"))).toBe(true);
    expect(existsSync(join(ROOT, ".agents", "skills", "first-tree-cli-framework", "SKILL.md"))).toBe(true);
    expect(existsSync(join(ROOT, ".claude", "skills", "first-tree-cli-framework", "SKILL.md"))).toBe(true);
  });

  it("keeps the skill source, mirrors, and snapshot in sync", () => {
    execFileSync("bash", ["./skills/first-tree-cli-framework/scripts/check-skill-sync.sh"], {
      cwd: ROOT,
      stdio: "pipe",
      encoding: "utf-8",
    });
  });

  it("passes the portable smoke test", () => {
    execFileSync("bash", ["./skills/first-tree-cli-framework/scripts/portable-smoke-test.sh"], {
      cwd: ROOT,
      stdio: "pipe",
      encoding: "utf-8",
    });
  });

  it("keeps naming and installation guidance aligned", () => {
    const read = (path: string) => readFileSync(join(ROOT, path), "utf-8");

    expect(read("README.md")).not.toContain("seed-tree");
    expect(read("docs/onboarding.md")).not.toContain("seed-tree");
    expect(read("AGENTS.md")).not.toContain("seed-tree");

    const onboarding = read("docs/onboarding.md");
    expect(onboarding).toContain("npx first-tree init");
    expect(onboarding).toContain("npm install -g first-tree");

    const quickstart = read("skills/first-tree-cli-framework/references/portable-quickstart.md");
    expect(quickstart).toContain("npx first-tree --help");
    expect(quickstart).toContain("npm install -g first-tree");
    expect(quickstart).toMatch(
      /snapshot base commit when this portable copy was refreshed: `[0-9a-f]{40}`/,
    );
  });
});
