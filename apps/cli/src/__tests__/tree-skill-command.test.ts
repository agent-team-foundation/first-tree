import { resolve } from "node:path";
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const collectSkillDiagnosisMock = vi.fn();
const collectSkillStatusMock = vi.fn();
const copyCanonicalSkillsMock = vi.fn();
const repairClaudeSkillLinksMock = vi.fn();

function context(root: string, json = false) {
  const command = new Command();
  command.option("--root <path>");
  command.setOptionValue("root", root);
  return { command, options: { debug: false, json, quiet: false } };
}

async function loadSubcommands() {
  vi.doMock("../commands/tree/skill-lib.js", () => ({
    SKILL_NAMES: ["first-tree", "first-tree-cloud"],
    collectSkillDiagnosis: collectSkillDiagnosisMock,
    collectSkillStatus: collectSkillStatusMock,
    copyCanonicalSkills: copyCanonicalSkillsMock,
    repairClaudeSkillLinks: repairClaudeSkillLinksMock,
  }));

  return (await import("../commands/tree/skill.js")).skillSubcommands;
}

describe("tree skill subcommands", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.exitCode = undefined;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    collectSkillStatusMock.mockReturnValue([
      { name: "first-tree", installed: true, compatible: true, version: "1.0.0", cliCompat: ">=0.5" },
      { name: "first-tree-cloud", installed: true, compatible: false, version: "0.1.0", cliCompat: "^0.4" },
      { name: "missing-skill", installed: false, compatible: null, version: null, cliCompat: null },
    ]);
    collectSkillDiagnosisMock.mockReturnValue([
      { name: "first-tree", ok: true, problems: [], incompatibleCliCompat: null, cliVersion: "0.5.2" },
      {
        name: "first-tree-cloud",
        ok: false,
        problems: ["manifest missing"],
        incompatibleCliCompat: "^0.4",
        cliVersion: "0.5.2",
      },
      {
        name: "missing-skill",
        ok: false,
        problems: ["not installed"],
        incompatibleCliCompat: null,
        cliVersion: "0.5.2",
      },
    ]);
    repairClaudeSkillLinksMock.mockReturnValue({
      linked: 1,
      skipped: 1,
      messages: ["linked first-tree", "skipped first-tree-cloud"],
    });
  });

  it("installs and upgrades shipped skills under the selected root", async () => {
    const subcommands = await loadSubcommands();

    subcommands.find((entry) => entry.name === "install")?.action(context("target-root"));
    subcommands.find((entry) => entry.name === "upgrade")?.action(context("target-root"));

    expect(copyCanonicalSkillsMock).toHaveBeenCalledTimes(2);
    expect(copyCanonicalSkillsMock).toHaveBeenCalledWith(resolve("target-root"));
    const printed = logSpy.mock.calls.flat().join("\n");
    expect(printed).toContain("Installed 2 shipped first-tree skills");
    expect(printed).toContain("Upgraded 2 shipped first-tree skills");
  });

  it("lists skill status in table and JSON modes", async () => {
    const subcommands = await loadSubcommands();
    const list = subcommands.find((entry) => entry.name === "list");
    if (!list) throw new Error("missing list subcommand");

    list.action(context("target-root"));
    let printed = logSpy.mock.calls.flat().join("\n");
    expect(printed).toContain("NAME");
    expect(printed).toContain("installed");
    expect(printed).toContain("incompatible");
    expect(printed).toContain("missing");

    logSpy.mockClear();
    list.action(context("target-root", true));
    printed = logSpy.mock.calls.flat().join("\n");
    expect(JSON.parse(printed)).toHaveLength(3);
  });

  it("diagnoses skill failures and links Claude aliases", async () => {
    const subcommands = await loadSubcommands();
    const doctor = subcommands.find((entry) => entry.name === "doctor");
    const link = subcommands.find((entry) => entry.name === "link");
    if (!doctor || !link) throw new Error("missing subcommand");

    doctor.action(context("target-root"));

    let printed = logSpy.mock.calls.flat().join("\n");
    expect(process.exitCode).toBe(1);
    expect(printed).toContain("FAIL first-tree-cloud");
    expect(printed).toContain("requires first-tree ^0.4");
    expect(printed).toContain("first-tree tree skill upgrade");

    logSpy.mockClear();
    link.action(context("target-root"));
    printed = logSpy.mock.calls.flat().join("\n");
    expect(printed).toContain("linked first-tree");
    expect(printed).toContain("Linked 1 symlink(s); skipped 1 skill(s)");
  });
});
