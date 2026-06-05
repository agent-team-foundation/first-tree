import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { skillSubcommands } from "../commands/tree/skill.js";

let root: string;
let stdout = "";
const stdoutSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
  stdout += `${args.join(" ")}\n`;
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ft-tree-skill-command-"));
  stdout = "";
  process.exitCode = undefined;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  stdoutSpy.mockClear();
  process.exitCode = undefined;
});

function installSkill(name: string, options: { cliCompat?: string; link?: boolean; version?: string } = {}): void {
  const skillRoot = join(root, ".agents", "skills", name);
  mkdirSync(join(skillRoot, "agents"), { recursive: true });
  const version = options.version ?? "1.0.0";
  writeFileSync(
    join(skillRoot, "SKILL.md"),
    `---\nname: ${name}\nversion: ${version}\ncliCompat:\n  first-tree: "${options.cliCompat ?? ">=0.0.0"}"\n---\n# ${name}\n`,
  );
  writeFileSync(join(skillRoot, "VERSION"), `${version}\n`);
  writeFileSync(join(skillRoot, "agents", "openai.yaml"), "name: test\n");
  if (options.link ?? true) {
    mkdirSync(join(root, ".claude", "skills"), { recursive: true });
    symlinkSync(join("..", "..", ".agents", "skills", name), join(root, ".claude", "skills", name));
  }
}

async function runSkillCommand(argv: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  const group = program.command("skill");
  for (const subcommand of skillSubcommands) {
    const command = group.command(subcommand.name).description(subcommand.description);
    subcommand.configure?.(command);
    command.option("--json", "json output");
    command.action(async () => {
      const options = command.opts() as { json?: boolean };
      await subcommand.action({ command, options: { debug: false, json: options.json === true, quiet: false } });
    });
  }

  await program.parseAsync(["node", "test", "skill", ...argv]);
}

describe("tree skill command actions", () => {
  it("prints list output in table and JSON modes", async () => {
    installSkill("first-tree-onboarding");

    await runSkillCommand(["list", "--root", root]);
    expect(stdout).toContain("NAME");
    expect(stdout).toContain("first-tree-onboarding");
    expect(stdout).toContain("installed");
    expect(stdout).toContain("first-tree");
    expect(stdout).toContain("missing");

    stdout = "";
    await runSkillCommand(["list", "--root", root, "--json"]);
    const rows = JSON.parse(stdout) as Array<{ name: string; installed: boolean }>;
    expect(rows.find((row) => row.name === "first-tree-onboarding")).toMatchObject({ installed: true });
  });

  it("reports doctor failures, incompatible ranges, and repair hints", async () => {
    installSkill("first-tree-sync", { cliCompat: ">999.0.0" });
    installSkill("first-tree-onboarding", { link: false });

    await runSkillCommand(["doctor", "--root", root]);

    expect(process.exitCode).toBe(1);
    expect(stdout).toContain("=== first-tree tree skill doctor ===");
    expect(stdout).toContain("FAIL first-tree-sync");
    expect(stdout).toContain("requires first-tree >999.0.0");
    expect(stdout).toContain("Repair shipped skill payloads with:");
    expect(stdout).toContain("first-tree tree skill link");
  });

  it("prints doctor JSON without human repair hints", async () => {
    await runSkillCommand(["doctor", "--root", root, "--json"]);

    expect(process.exitCode).toBe(1);
    const rows = JSON.parse(stdout) as Array<{ name: string; ok: boolean }>;
    expect(rows.some((row) => row.name === "first-tree" && !row.ok)).toBe(true);
  });

  it("links missing Claude aliases", async () => {
    installSkill("first-tree-onboarding", { link: false });
    await runSkillCommand(["link", "--root", root]);

    expect(stdout).toContain(
      "linked .claude/skills/first-tree-onboarding -> ../../.agents/skills/first-tree-onboarding",
    );
    expect(stdout).toContain("Linked 1 symlink(s)");
  });

  it("installs and upgrades shipped skills", async () => {
    await runSkillCommand(["install", "--root", root]);
    expect(stdout).toContain("Installed 4 shipped first-tree skills");

    stdout = "";
    await runSkillCommand(["upgrade", "--root", root]);
    expect(stdout).toContain("Upgraded 4 shipped first-tree skills");
  });
});
