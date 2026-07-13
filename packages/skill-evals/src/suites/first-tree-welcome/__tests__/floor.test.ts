import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SkillEvalCase } from "../../../core/case-schema.js";
import { FIRST_TREE_WELCOME_SUITE } from "../cases.js";

// These tests run in `pnpm test` / CI (unlike the model-gated eval:* commands),
// so they are where the welcome matrix's structural invariants are actually
// locked: no orphan implemented action, exactly one catch-all, and unambiguous
// first-match-wins (unique state tuples). They guard against the drift class
// that produced #1341 → #1344.

const validateFloor = FIRST_TREE_WELCOME_SUITE.validateFloor;
if (!validateFloor) {
  throw new Error("first-tree-welcome suite must define validateFloor");
}
const cases = FIRST_TREE_WELCOME_SUITE.cases;
const skillMarkdown = readFileSync(join(process.cwd(), "../../skills/first-tree-welcome/SKILL.md"), "utf8");

function hasTag(evalCase: SkillEvalCase, tag: string): boolean {
  const tags = (evalCase as { tags?: readonly string[] }).tags;
  return Array.isArray(tags) && tags.includes(tag);
}

describe("first-tree-welcome floor invariants", () => {
  it("accepts the shipped matrix with no errors", () => {
    expect(validateFloor(cases)).toEqual([]);
  });

  it("implements periodic coverage for every concrete non-catch-all matrix row", () => {
    const periodicCases = cases.filter((evalCase) => evalCase.tier === "periodic");

    expect(periodicCases).toHaveLength(10);
    expect(periodicCases.every((evalCase) => evalCase.status === "implemented")).toBe(true);
    expect(
      periodicCases.every((evalCase) => (evalCase.expected as { activation?: unknown }).activation === "preloaded"),
    ).toBe(true);
    expect(periodicCases.some((evalCase) => hasTag(evalCase, "catch-all"))).toBe(false);
  });

  it("runs exact positive and negative routing shapes as model-backed gate cases", () => {
    const liveGateCases = cases.filter(
      (evalCase) => evalCase.tier === "gate" && evalCase.status === "implemented",
    ) as Array<{
      expected: { activation?: string };
      id: string;
      prompt?: string;
    }>;
    const byId = new Map(liveGateCases.map((evalCase) => [evalCase.id, evalCase]));

    const admin = byId.get("first-tree-welcome-admin-trigger");
    expect(admin?.expected.activation).toBe("auto-trigger");
    expect(admin?.prompt).toContain("welcome aboard");
    expect(admin?.prompt).toContain("Please help me get started with First Tree");

    const invitee = byId.get("first-tree-welcome-invitee-trigger");
    expect(invitee?.expected.activation).toBe("auto-trigger");
    expect(invitee?.prompt).toContain("welcome aboard");
    expect(invitee?.prompt).toContain("Please help me get settled into this team on First Tree");

    const scanFix = byId.get("first-tree-welcome-scan-fix-direct-trigger");
    expect(scanFix?.expected.activation).toBe("auto-trigger");
    expect(scanFix?.prompt).toContain("fix the launch blockers found by my production readiness scan");
    expect(scanFix?.prompt).not.toContain("welcome aboard");

    const ordinary = byId.get("first-tree-welcome-ordinary-chat-no-trigger");
    expect(ordinary?.expected.activation).toBe("auto-ignore");
    expect(ordinary?.prompt).not.toContain("welcome aboard");
    expect(ordinary?.prompt).not.toContain("Please help me get started with First Tree");
    expect(ordinary?.prompt).not.toContain("Please help me get settled into this team on First Tree");
    expect(ordinary?.prompt).not.toContain("fix the launch blockers found by my production readiness scan");

    const treeSetup = byId.get("first-tree-welcome-tree-setup-no-trigger");
    expect(treeSetup?.expected.activation).toBe("auto-ignore");
    expect(treeSetup?.prompt).not.toContain("welcome aboard");
    expect(treeSetup?.prompt).not.toContain("fix the launch blockers found by my production readiness scan");
  });

  it("flags an implemented row whose action has no casePassed branch (orphan)", () => {
    // Deliberately break one implemented row's action; `expected` is the schema's
    // generic `unknown`, so a plain override is type-safe here.
    const broken = cases.map(
      (evalCase): SkillEvalCase =>
        evalCase.tier === "gate" && evalCase.status === "implemented"
          ? { ...evalCase, expected: { ...(evalCase.expected as Record<string, unknown>), action: "made_up_action" } }
          : evalCase,
    );
    expect(validateFloor(broken).some((error) => error.includes("orphan"))).toBe(true);
  });

  it("rejects an auto-trigger routing case without an exact kickoff opener", () => {
    const broken = cases.map((evalCase) =>
      evalCase.id === "first-tree-welcome-admin-trigger" ? { ...evalCase, prompt: "Welcome the user." } : evalCase,
    );

    expect(validateFloor(broken).some((error) => error.includes("does not match an exact welcome kickoff"))).toBe(true);
  });

  it("rejects a periodic matrix row that claims automatic activation", () => {
    const broken = cases.map((evalCase) =>
      evalCase.tier === "periodic"
        ? { ...evalCase, expected: { ...(evalCase.expected as Record<string, unknown>), activation: "auto-trigger" } }
        : evalCase,
    );

    expect(validateFloor(broken).some((error) => error.includes("periodic matrix rows must use preloaded"))).toBe(true);
  });

  it("flags an implemented periodic row whose action has no casePassed branch (orphan)", () => {
    const broken = cases.map(
      (evalCase): SkillEvalCase =>
        evalCase.tier === "periodic" && evalCase.status === "implemented"
          ? { ...evalCase, expected: { ...(evalCase.expected as Record<string, unknown>), action: "made_up_action" } }
          : evalCase,
    );
    expect(validateFloor(broken).some((error) => error.includes("orphan"))).toBe(true);
  });

  it("flags an implemented row whose forbidden action has no detector branch (orphan)", () => {
    const broken = cases.map(
      (evalCase): SkillEvalCase =>
        evalCase.tier === "periodic" && evalCase.status === "implemented"
          ? {
              ...evalCase,
              forbidden: { ...(evalCase.forbidden as Record<string, unknown>), actions: ["made-up-risk"] },
            }
          : evalCase,
    );
    expect(validateFloor(broken).some((error) => error.includes("forbidden action"))).toBe(true);
  });

  it("flags two non-catch-all rows that claim the same state tuple", () => {
    const sample = cases.find((evalCase) => evalCase.tier === "gate" && !hasTag(evalCase, "catch-all"));
    if (!sample) throw new Error("expected at least one non-catch-all gate row");
    // A second row with the same fixture tuple makes first-match-wins ambiguous.
    const duplicate: SkillEvalCase = { ...sample, id: `${sample.id}-dup` };
    expect(validateFloor([...cases, duplicate]).some((error) => error.includes("overlapping state tuple"))).toBe(true);
  });

  it("requires exactly one explicit catch-all row", () => {
    const withoutCatchAll = cases.filter((evalCase) => !hasTag(evalCase, "catch-all"));
    expect(validateFloor(withoutCatchAll).some((error) => error.includes("catch-all"))).toBe(true);
  });

  it("requires the catch-all row to be the last gate row", () => {
    const sample = cases.find((evalCase) => evalCase.tier === "gate" && !hasTag(evalCase, "catch-all"));
    if (!sample) throw new Error("expected at least one non-catch-all gate row");
    // A specific (non-catch-all) row placed AFTER the catch-all would be
    // unreachable under first-match-wins. Give it a unique tuple so only the
    // "must be last" invariant fires, not the uniqueness one.
    const trailing: SkillEvalCase = {
      ...sample,
      id: `${sample.id}-trailing`,
      fixture: {
        ...(sample.fixture as Record<string, unknown>),
        role: "invitee",
        chatScenario: "tree-setup",
        repoState: "local-readable",
        treeState: "empty",
      },
    };
    expect(validateFloor([...cases, trailing]).some((error) => error.includes("must be last"))).toBe(true);
  });

  it("keeps onboarding attribution and no-project first reply guidance aligned with the product flow", () => {
    const description = skillMarkdown.match(/^description:\s*(.*)$/m)?.[1] ?? "";

    expect(description).not.toContain("local project folder path");
    expect(skillMarkdown).toContain("Treat the opening message as the user's onboarding request.");
    expect(skillMarkdown).toContain("local project folder path");
    expect(skillMarkdown).toContain("GitHub repo URL");
    expect(skillMarkdown).not.toContain("First Tree sent it");
  });

  it("keeps the skill's example trigger phrases in sync with the real onboarding bootstraps", () => {
    // Skill activation now rests entirely on the visible message matching the
    // skill description (no hidden directive — see the onboarding kickoff
    // contract). The skill hard-codes the product's kickoff openers as its
    // activation examples, so bind them to the real copy: a reword in
    // bootstrap-prose.ts must not silently drift the skill's trigger examples
    // and weaken selection.
    const bootstrapProse = readFileSync(
      join(process.cwd(), "../web/src/pages/workspace/center/onboarding/bootstrap-prose.ts"),
      "utf8",
    );
    const sharedOpeners = [
      "welcome aboard",
      "Please help me get started with First Tree",
      "Please help me get settled into this team on First Tree",
    ];
    for (const opener of sharedOpeners) {
      expect(skillMarkdown, `skill should reference the real kickoff opener: "${opener}"`).toContain(opener);
      expect(bootstrapProse, `bootstrap-prose.ts should still ship the kickoff opener: "${opener}"`).toContain(opener);
    }

    const description = skillMarkdown.match(/^description:\s*(.*)$/m)?.[1] ?? "";
    expect(description).toContain('"welcome aboard" together with either');
    expect(description).toContain('or explicitly asks to "fix the launch blockers');
    expect(description).not.toContain("natural opening messages");
    expect(skillMarkdown).toContain("Do not infer onboarding from the chat being new or from a generic greeting.");
  });

  it("keeps the OpenAI/Codex routing metadata description in sync with SKILL.md", () => {
    // `skills/<name>/agents/openai.yaml` is a second shipped routing surface:
    // the composer/runtime read it to select the skill on the OpenAI/Codex side.
    // Since activation is description-driven (no hidden directive), a stale
    // description here can still follow the retired explicit-name trigger and
    // miss the repo-scan exclusion even when SKILL.md is correct. Bind the two
    // so a copy reword cannot drift one surface without the other.
    const openaiYaml = readFileSync(join(process.cwd(), "../../skills/first-tree-welcome/agents/openai.yaml"), "utf8");
    const skillDescription = skillMarkdown.match(/^description:\s*(.*)$/m)?.[1] ?? "";
    const yamlDescription = openaiYaml.match(/^description:\s*(.*)$/m)?.[1] ?? "";

    expect(skillDescription, "SKILL.md must declare a description").not.toBe("");
    expect(yamlDescription, "openai.yaml description must match SKILL.md description").toBe(skillDescription);
    // Guard the specific retired trigger the drift-guard exists to catch.
    expect(yamlDescription).not.toContain("explicitly names first-tree-welcome");
    expect(yamlDescription).toContain("repo scans");
  });

  it("keeps one shared agent-briefing welcome definition on exact kickoff shapes", () => {
    // The tree-less and tree-bound maps render one shared definition. Keep the
    // source-level floor focused on the exact trigger; the client rendering test
    // binds both generated rows to SKILL.md and checks each appears once.
    const briefing = readFileSync(join(process.cwd(), "../client/src/runtime/agent-briefing.ts"), "utf8");
    const skillDescription = skillMarkdown.match(/^description:\s*(.*)$/m)?.[1] ?? "";
    const sharedDefinitionCount = briefing.split(skillDescription).length - 1;

    expect(skillDescription, "SKILL.md must declare a description").not.toBe("");
    expect(sharedDefinitionCount, "the briefing source must define the canonical welcome description once").toBe(1);
    // The retired un-hardened hints must be gone.
    expect(briefing).not.toContain("onboarding welcome / intro / value-first first chat");
    expect(briefing).not.toContain("onboarding system messages ask for welcome");
    expect(briefing).not.toContain('a natural welcome / "help me get started"');
  });

  it("keeps production-scan fix fan-out aligned with the scan's 3-5 blocker contract", () => {
    expect(skillMarkdown).toContain("up to 5 eligible blockers");
    expect(skillMarkdown).toMatch(/Production-scan normally\s+reports 3-5 blockers/);
    expect(skillMarkdown).toContain("Do not split one blocker into implementation-step chats");
    expect(skillMarkdown).toContain("verify the finding still applies");
    expect(skillMarkdown).toContain("covered by existing code or an already-open PR");
    expect(skillMarkdown).not.toContain("top ~4");
  });

  it("does not depend on production-scan confidence fields that ps-1 reports do not emit", () => {
    expect(skillMarkdown).toContain("Eligible means the finding has concrete evidence");
    expect(skillMarkdown).toContain("needs product, architecture, or security-design judgment");
    expect(skillMarkdown).not.toContain("highest-leverage AND `confirmed`");
    expect(skillMarkdown).not.toContain("low-`confidence` findings");
    expect(skillMarkdown).not.toContain("triaged the confirmed safe blockers");
  });
});
