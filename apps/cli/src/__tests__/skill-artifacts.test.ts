import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
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

  // The Communication Rules / Sending Messages content was sunk from
  // `bootstrap.ts` `generateToolsDoc()` into the first-tree-cloud skill per
  // proposal `skill-restructure.20260602` P3. These assertions pin the
  // invariants in their new home so a future skill edit doesn't silently
  // drop them.
  describe("first-tree-cloud carries the Agent-to-Agent Communication invariants (proposal P3)", () => {
    const skillMd = readFileSync(join(ROOT, "skills", "first-tree-cloud", "SKILL.md"), "utf-8");
    const referenceMd = readFileSync(
      join(ROOT, "skills", "first-tree-cloud", "references", "agent-communication.md"),
      "utf-8",
    );

    it("SKILL.md pins the final-text contract + decision-guide table", () => {
      expect(skillMd).toContain("Agent-to-Agent Communication");
      expect(skillMd).toContain("human observers");
      expect(skillMd).toContain("does **NOT** wake other agents");
      expect(skillMd).toMatch(/\*\*human\*\* in this chat/);
      expect(skillMd).toMatch(/\*\*agent\*\* in this chat/);
      expect(skillMd).toContain("Fallback");
      expect(skillMd).toContain("conservative mode");
    });

    it("references/agent-communication.md teaches `chat invite` instead of the retired --direct escape hatch", () => {
      expect(referenceMd).toContain("first-tree chat invite");
      expect(referenceMd).toContain("first-tree chat send");
      expect(referenceMd).toMatch(/recipient MUST be a participant/);
      expect(referenceMd).toMatch(/Reaching another agent/);
      expect(referenceMd).toMatch(/only addresses agents by name/);
      // The retired escape hatches must NOT be taught.
      expect(referenceMd).not.toMatch(/--direct/);
      expect(referenceMd).not.toMatch(/--chat <chatId>/);
      expect(referenceMd).not.toMatch(/--chat <directChatId>/);
      // Anti-double-encode (Issue #389) — the long form lives here; tools.md
      // also pins the one-line invariant.
      expect(referenceMd).toContain("JSON.stringify");
    });
  });
});
