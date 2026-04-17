import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runInstall } from "../../src/meta/skill-tools/engine/commands/install.js";
import { runDoctor } from "../../src/meta/skill-tools/engine/commands/doctor.js";
import { runLink } from "../../src/meta/skill-tools/engine/commands/link.js";
import { runList } from "../../src/meta/skill-tools/engine/commands/list.js";
import { runUpgrade } from "../../src/meta/skill-tools/engine/commands/upgrade.js";
import { useTmpDir } from "../helpers.js";

function seedAgentsSkill(root: string, name: string, version = "0.2"): void {
  const dir = join(root, ".agents", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: test\n---\n`,
  );
  writeFileSync(join(dir, "VERSION"), `${version}\n`);
  if (name === "first-tree") {
    const refs = join(dir, "references");
    mkdirSync(refs, { recursive: true });
    for (const filename of [
      "whitepaper.md",
      "onboarding.md",
      "source-workspace-installation.md",
      "principles.md",
      "ownership-and-naming.md",
      "upgrade-contract.md",
    ]) {
      writeFileSync(join(refs, filename), `# ${filename}\n`);
    }
  }
}

function seedClaudeSymlink(root: string, name: string): void {
  const claudeDir = join(root, ".claude", "skills");
  mkdirSync(claudeDir, { recursive: true });
  symlinkSync(
    join("..", "..", ".agents", "skills", name),
    join(claudeDir, name),
  );
}

describe("first-tree skill list", () => {
  it("reports installed skills with their versions", () => {
    const tmp = useTmpDir();
    seedAgentsSkill(tmp.path, "first-tree", "0.3");
    seedClaudeSymlink(tmp.path, "first-tree");

    const lines: string[] = [];
    const code = runList([], {
      targetRoot: tmp.path,
      write: (t) => lines.push(t),
    });

    expect(code).toBe(0);
    const body = lines.join("\n");
    expect(body).toContain("first-tree");
    expect(body).toContain("installed");
    expect(body).toContain("0.3");
    expect(body).toContain("tree");
    expect(body).toContain("missing");
  });
});

describe("first-tree skill install / upgrade", () => {
  it("installs all four skills into an empty target root", () => {
    const tmp = useTmpDir();
    const lines: string[] = [];

    const code = runInstall([], {
      targetRoot: tmp.path,
      write: (t) => lines.push(t),
    });

    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("Installed the four shipped first-tree skills");
    for (const name of ["first-tree", "tree", "breeze", "gardener"]) {
      expect(existsSync(join(tmp.path, ".agents", "skills", name, "SKILL.md"))).toBe(true);
    }
  });

  it("upgrades an existing install in place", () => {
    const tmp = useTmpDir();
    seedAgentsSkill(tmp.path, "first-tree", "0.1");
    seedClaudeSymlink(tmp.path, "first-tree");

    const lines: string[] = [];
    const code = runUpgrade([], {
      targetRoot: tmp.path,
      write: (t) => lines.push(t),
    });

    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("Upgraded the four shipped first-tree skills");
  });
});

describe("first-tree skill doctor", () => {
  it("exits 1 when a skill is missing", () => {
    const tmp = useTmpDir();
    const lines: string[] = [];
    const code = runDoctor([], {
      targetRoot: tmp.path,
      write: (t) => lines.push(t),
    });

    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("missing: .agents/skills/first-tree");
  });

  it("exits 0 when all four skills are healthy", () => {
    const tmp = useTmpDir();
    for (const name of ["first-tree", "tree", "breeze", "gardener"]) {
      seedAgentsSkill(tmp.path, name);
      seedClaudeSymlink(tmp.path, name);
    }

    const lines: string[] = [];
    const code = runDoctor([], {
      targetRoot: tmp.path,
      write: (t) => lines.push(t),
    });

    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("All four skills are installed and healthy.");
  });

  it("exits 1 when the entry-point skill is missing required reference files", () => {
    const tmp = useTmpDir();
    for (const name of ["first-tree", "tree", "breeze", "gardener"]) {
      seedAgentsSkill(tmp.path, name);
      seedClaudeSymlink(tmp.path, name);
    }

    rmSync(
      join(tmp.path, ".agents", "skills", "first-tree", "references", "upgrade-contract.md"),
      { force: true },
    );

    const lines: string[] = [];
    const code = runDoctor([], {
      targetRoot: tmp.path,
      write: (t) => lines.push(t),
    });

    expect(code).toBe(1);
    expect(lines.join("\n")).toContain(
      ".agents/skills/first-tree/references/upgrade-contract.md does not exist",
    );
  });
});

describe("first-tree skill link", () => {
  it("creates missing .claude/ symlinks from existing .agents/ installs", () => {
    const tmp = useTmpDir();
    seedAgentsSkill(tmp.path, "first-tree");
    seedAgentsSkill(tmp.path, "tree");

    const lines: string[] = [];
    const code = runLink([], {
      targetRoot: tmp.path,
      write: (t) => lines.push(t),
    });

    expect(code).toBe(0);
    const body = lines.join("\n");
    expect(body).toContain("linked .claude/skills/first-tree");
    expect(body).toContain("linked .claude/skills/tree");
    expect(body).toContain("skipped 2 skill(s)");
  });

  it("is idempotent — re-running does not re-link correct symlinks", () => {
    const tmp = useTmpDir();
    seedAgentsSkill(tmp.path, "first-tree");
    seedClaudeSymlink(tmp.path, "first-tree");

    const lines: string[] = [];
    const code = runLink([], {
      targetRoot: tmp.path,
      write: (t) => lines.push(t),
    });

    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("Linked 0 symlink(s)");
  });
});
