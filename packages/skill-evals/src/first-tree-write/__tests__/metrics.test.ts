import { describe, expect, it } from "vitest";

import { casePassed, deriveMetrics, withAccidentalWriteHit } from "../metrics.js";
import type { EvalMetrics, FixtureValidation } from "../types.js";

const TARGET_PATH = "systems/server/auth/jwt";
const HELP_ARGV = ["tree", "tree", "--help"];
const TREE_TREE_ARGV = ["tree", "tree"];
const TARGET_TREE_ARGV = ["tree", "tree", "systems/server/auth"];

const VALID_FIXTURE: FixtureValidation = {
  domainNodeCount: 48,
  errors: [],
  minDepthOk: true,
  ok: true,
  requiredFilesOk: true,
  verifyResult: null,
};

function skillReadEvent(skillName: string): unknown {
  return {
    event: {
      command: `sed -n '1,200p' .agents/skills/${skillName}/SKILL.md`,
      type: "tool_call",
    },
    type: "codex_event",
  };
}

function assistantTextEvent(text: string): unknown {
  return {
    event: {
      content: text,
      type: "assistant_message",
    },
    type: "codex_event",
  };
}

function firstTreeCall(argv: readonly string[]): unknown {
  return {
    argv: [...argv],
    phase: "model",
    type: "first_tree_call",
  };
}

function firstTreeResult(argv: readonly string[], exitCode: number, stdoutPreview = ""): unknown {
  return {
    argv: [...argv],
    exitCode,
    phase: "model",
    stdoutPreview,
    type: "first_tree_result",
  };
}

function metrics(events: readonly unknown[]): EvalMetrics {
  return deriveMetrics(events, VALID_FIXTURE, 0, TARGET_PATH);
}

describe("first-tree-write metrics pass criteria", () => {
  it("passes trigger cases only when write skill is loaded, tree tree is called, target is observed, and commands succeed", () => {
    const result = metrics([
      skillReadEvent("first-tree-write"),
      firstTreeCall(TREE_TREE_ARGV),
      firstTreeResult(TREE_TREE_ARGV, 0, `context-tree/\n└── ${TARGET_PATH}/ [Systems Server Auth Jwt]`),
      firstTreeCall(TARGET_TREE_ARGV),
      firstTreeResult(TARGET_TREE_ARGV, 0, TARGET_PATH),
      assistantTextEvent(`Planned write target: ${TARGET_PATH}`),
    ]);

    expect(result.writeSkillFileReadObserved).toBe(true);
    expect(result.treeTreeSucceeded).toBe(true);
    expect(result.targetPathObserved).toBe(true);
    expect(result.modelFirstTreeCommandsOk).toBe(true);
    expect(casePassed(true, result, { allowReadSkillTreeLookupOnNonTrigger: false })).toBe(true);
  });

  it("fails trigger cases when the target is guessed without first-tree tree tree", () => {
    const result = metrics([skillReadEvent("first-tree-write"), assistantTextEvent(`I will update ${TARGET_PATH}.`)]);

    expect(result.writeSkillFileReadObserved).toBe(true);
    expect(result.treeTreeSucceeded).toBe(false);
    expect(result.targetMentionedInOutput).toBe(true);
    expect(result.targetPathObserved).toBe(false);
    expect(casePassed(true, result, { allowReadSkillTreeLookupOnNonTrigger: false })).toBe(false);
  });

  it("fails trigger cases when only first-tree tree tree --help runs before the target is guessed", () => {
    const result = metrics([
      skillReadEvent("first-tree-write"),
      firstTreeCall(HELP_ARGV),
      firstTreeResult(HELP_ARGV, 0, "usage: first-tree tree tree [path]"),
      assistantTextEvent(`Planned write target: ${TARGET_PATH}`),
    ]);

    expect(result.treeTreeSucceeded).toBe(false);
    expect(result.targetPathObserved).toBe(false);
    expect(casePassed(true, result, { allowReadSkillTreeLookupOnNonTrigger: false })).toBe(false);
  });

  it("fails non-trigger cases on any write skill load or write-specific output", () => {
    const loaded = withAccidentalWriteHit(metrics([skillReadEvent("first-tree-write")]), false);
    const output = withAccidentalWriteHit(metrics([assistantTextEvent(`Planned write target: ${TARGET_PATH}`)]), false);

    expect(loaded.accidentalWriteHit).toBe(true);
    expect(casePassed(false, loaded, { allowReadSkillTreeLookupOnNonTrigger: false })).toBe(false);
    expect(output.writeIntentInOutput).toBe(true);
    expect(casePassed(false, output, { allowReadSkillTreeLookupOnNonTrigger: false })).toBe(false);
  });

  it("fails non-trigger cases when write-only setup performs tree target selection", () => {
    const result = metrics([
      firstTreeCall(TREE_TREE_ARGV),
      firstTreeResult(TREE_TREE_ARGV, 0, `context-tree/\n└── ${TARGET_PATH}/ [Systems Server Auth Jwt]`),
    ]);

    expect(result.treeTreeCalls).toBe(1);
    expect(casePassed(false, result, { allowReadSkillTreeLookupOnNonTrigger: false })).toBe(false);
  });

  it("allows dual-skill read-only prompts to use first-tree-read without first-tree-write", () => {
    const result = metrics([
      skillReadEvent("first-tree-read"),
      firstTreeCall(TREE_TREE_ARGV),
      firstTreeResult(TREE_TREE_ARGV, 0, `context-tree/\n└── ${TARGET_PATH}/ [Systems Server Auth Jwt]`),
      assistantTextEvent("Existing JWT auth context uses the user JWT and live membership checks."),
    ]);

    expect(result.readSkillFileReadObserved).toBe(true);
    expect(result.writeSkillFileReadObserved).toBe(false);
    expect(casePassed(false, result, { allowReadSkillTreeLookupOnNonTrigger: true })).toBe(true);
  });

  it("keeps dual-skill write prompts green only when first-tree-write is used", () => {
    const readOnlyResult = metrics([
      skillReadEvent("first-tree-read"),
      firstTreeCall(TREE_TREE_ARGV),
      firstTreeResult(TREE_TREE_ARGV, 0, `context-tree/\n└── ${TARGET_PATH}/ [Systems Server Auth Jwt]`),
      assistantTextEvent(`Target path: ${TARGET_PATH}`),
    ]);
    const writeResult = metrics([
      skillReadEvent("first-tree-write"),
      firstTreeCall(TREE_TREE_ARGV),
      firstTreeResult(TREE_TREE_ARGV, 0, `context-tree/\n└── ${TARGET_PATH}/ [Systems Server Auth Jwt]`),
      assistantTextEvent(`Planned write target: ${TARGET_PATH}`),
    ]);

    expect(casePassed(true, readOnlyResult, { allowReadSkillTreeLookupOnNonTrigger: true })).toBe(false);
    expect(casePassed(true, writeResult, { allowReadSkillTreeLookupOnNonTrigger: true })).toBe(true);
  });
});
