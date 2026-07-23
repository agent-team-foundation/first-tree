import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FIRST_TREE_READ_CASES } from "../cases.js";
import { FIRST_TREE_READ_SUITE } from "../eval-cases.js";

const validateFloor = FIRST_TREE_READ_SUITE.validateFloor;
if (!validateFloor) throw new Error("first-tree-read suite must define validateFloor");

const skill = readFileSync(join(process.cwd(), "../../skills/first-tree-read/SKILL.md"), "utf8");
const skillVersion = readFileSync(join(process.cwd(), "../../skills/first-tree-read/VERSION"), "utf8").trim();

describe("first-tree-read floor contract", () => {
  it("keeps the declared gate matrix complete", () => {
    expect(validateFloor(FIRST_TREE_READ_SUITE.cases)).toEqual([]);
    expect(FIRST_TREE_READ_CASES.map((evalCase) => evalCase.id)).toContain("byo-explicit-team-trigger");
  });

  it("states the fail-closed, exact-snapshot BYO activation boundary", () => {
    expect(skill).toContain("names an explicit First Tree Team id");
    expect(skill).toContain('first-tree --json tree read --team "<team-id>" --snapshot');
    expect(skill).toContain("run exactly\none activation");
    expect(skill).toContain("Authority, binding, fetch, commit, or snapshot failure is fail-closed");
    expect(skill).toContain("Do not run another Server request,\nfetch, pull, clone, or activation");
    expect(skill).toContain("include `--no-pull` on every selector");
    expect(skill).toContain("Never reuse a snapshot across\nTeams or tasks");
  });

  it("preserves the managed-workspace compatibility route", () => {
    expect(skill).toContain("Otherwise retain the **managed workspace** path below");
    expect(skill).toContain("pull-before-selector behavior");
  });

  it("routes provider-scoped PR/MR review to Context Review", () => {
    expect(skill).toContain("request to review a Context Tree PR/MR");
    expect(skill).toContain("supported GitHub PR or GitLab MR path");
    expect(skill).toContain("Cloud Web Context anonymous-read\navailability is unrelated");
    expect(skill).toContain("PR/MR or issue titles");
  });

  it("records only material decision influence on the same final message", () => {
    expect(skill).toContain("Attach a small `contextDecision` receipt only when all of these conditions hold");
    expect(skill).toMatch(/Opening a file is not\s+enough/);
    expect(skill).toContain("The read happened before the choice was made or executed");
    expect(skill).toContain("Do not emit `effect: none`");
    expect(skill).toContain("top-level `contextDecision` metadata");
    expect(skill).toContain("task correctly ends with a blocking `chat ask`");
    expect(skill).toContain("supply only the new\n`contextDecision` key");
    expect(skill).toContain("Choose the first matching category in this precedence\norder");
    expect(skill).toMatch(/`conflicted`[\s\S]+`redirected`[\s\S]+`constrained`[\s\S]+`confirmed`/);
    expect(skill).toContain("Cite at most three Tree-root-relative\nnormal node paths");
    expect(skill).toContain("require HEAD to remain unchanged");
    expect(skill).toContain("reachable from the bound branch's remote-tracking\n   ref");
    expect(skill).toContain("canonical repository identity rather than raw string\nequality");
    expect(skill).toContain("Never persist a credential-bearing remote URL");
    expect(skill).toMatch(/It is not\s+server-verified proof of causality/);

    const receiptBlock = /```json\n([\s\S]*?)\n```/.exec(skill);
    expect(receiptBlock).not.toBeNull();
    const parsed = JSON.parse(receiptBlock?.[1] ?? "{}") as {
      contextDecision?: {
        version?: number;
        effect?: string;
        summary?: string;
        evidence?: Array<{ repoUrl?: string; commit?: string; nodePath?: string; heading?: string }>;
      };
    };
    expect(parsed.contextDecision).toMatchObject({
      version: 1,
      effect: "constrained",
      summary: expect.any(String),
    });
    expect(parsed.contextDecision?.evidence).toHaveLength(1);
    expect(parsed.contextDecision?.evidence?.[0]).toMatchObject({
      repoUrl: "https://github.com/example/context-tree",
      nodePath: "system/cloud/team/tenancy-and-identity.md",
      heading: "Organization isolation",
    });
    expect(parsed.contextDecision?.evidence?.[0]?.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("keeps version metadata aligned", () => {
    expect(skillVersion).toBe("0.3.0");
    expect(skill).toContain(`version: ${skillVersion}`);
  });
});
