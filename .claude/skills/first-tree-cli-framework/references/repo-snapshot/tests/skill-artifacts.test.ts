import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
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
});
