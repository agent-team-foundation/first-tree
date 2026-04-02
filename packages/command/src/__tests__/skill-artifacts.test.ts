import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../../");

describe("skill artifacts", () => {
  it("keeps the source-of-truth skill and generated mirrors present", () => {
    expect(existsSync(join(ROOT, "skills", "first-tree-hub-cli", "SKILL.md"))).toBe(true);
    expect(existsSync(join(ROOT, ".agents", "skills", "first-tree-hub-cli", "SKILL.md"))).toBe(true);
    expect(existsSync(join(ROOT, ".claude", "skills", "first-tree-hub-cli", "SKILL.md"))).toBe(true);
  });

  it("keeps the skill source and mirrors in sync", () => {
    execFileSync("bash", ["./skills/first-tree-hub-cli/scripts/check-skill-sync.sh"], {
      cwd: ROOT,
      stdio: "pipe",
      encoding: "utf-8",
    });
  });
});
