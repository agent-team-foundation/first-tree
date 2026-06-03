import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../../");

describe("skill artifacts", () => {
  it("keeps the source-of-truth skill present", () => {
    expect(existsSync(join(ROOT, "skills", "first-tree", "SKILL.md"))).toBe(true);
  });

  // The Communication Rules / Sending Messages content lives in the
  // top-level `first-tree` skill (absorbed from the retired
  // `first-tree-cloud` skill). These assertions pin the runtime-load-
  // bearing invariants so a future skill edit doesn't silently drop them.
  describe("first-tree carries the Agent-to-Agent Communication invariants", () => {
    const skillMd = readFileSync(join(ROOT, "skills", "first-tree", "SKILL.md"), "utf-8");
    const referenceMd = readFileSync(
      join(ROOT, "skills", "first-tree", "references", "agent-communication.md"),
      "utf-8",
    );

    it("SKILL.md pins the final-text contract + decision-guide table", () => {
      expect(skillMd).toContain("Communication Principles");
      expect(skillMd).toContain("human observers");
      expect(skillMd).toContain("does **NOT** wake other agents");
      expect(skillMd).toMatch(/\*\*human\*\*/);
      expect(skillMd).toMatch(/\*\*agent\*\*/);
      expect(skillMd).toContain("Fallback");
      expect(skillMd).toContain("conservative mode");
    });

    it("references/agent-communication.md teaches `chat invite` instead of the retired --direct escape hatch", () => {
      expect(referenceMd).toContain("first-tree chat invite");
      expect(referenceMd).toContain("first-tree chat send");
      expect(referenceMd).toMatch(/recipient MUST be a participant/);
      expect(referenceMd).toMatch(/Reaching another agent/);
      expect(referenceMd).toMatch(/only addresses agents by name/);
      // The retired escape hatches must NOT be taught. The doc may still
      // mention `--direct` (or the other retired flags) in prose to
      // redirect agents that learned the old form ("no `--direct` flag
      // exists; use `chat invite` instead"). Only flag them when they
      // appear inside a fenced code block — that's where copy-execute
      // happens, and that's what makes a flag "taught" rather than
      // "described".
      const codeBlocks = referenceMd.match(/```[\s\S]*?```/gu) ?? [];
      for (const block of codeBlocks) {
        expect(block).not.toMatch(/--direct\b/u);
        expect(block).not.toMatch(/--chat <chatId>/u);
        expect(block).not.toMatch(/--chat <directChatId>/u);
      }
      // Anti-double-encode (Issue #389) — the long form lives here; tools.md
      // also pins the one-line invariant.
      expect(referenceMd).toContain("JSON.stringify");
    });
  });
});
