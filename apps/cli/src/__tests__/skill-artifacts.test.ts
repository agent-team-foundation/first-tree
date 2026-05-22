import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../../");

describe("skill artifacts", () => {
  it("keeps the source-of-truth skill present", () => {
    expect(existsSync(join(ROOT, "skills", "first-tree-cloud", "SKILL.md"))).toBe(true);
  });

  it("has symlinks for agent discovery directories", () => {
    for (const mirror of [".agents/skills/first-tree-cloud", ".claude/skills/first-tree-cloud"]) {
      const mirrorPath = join(ROOT, mirror);
      expect(lstatSync(mirrorPath).isSymbolicLink(), `${mirror} should be a symlink`).toBe(true);
      expect(readlinkSync(mirrorPath)).toBe("../../skills/first-tree-cloud");
    }
  });

  it("passes the symlink validation check", () => {
    execFileSync("bash", ["./skills/first-tree-cloud/scripts/check-skill-sync.sh"], {
      cwd: ROOT,
      stdio: "pipe",
      encoding: "utf-8",
    });
  });
});
