import { describe, expect, it } from "vitest";

import { gradingFailureMessages } from "../../../core/grading.js";
import { casePassed, deriveMetrics } from "../metrics.js";
import { buildGrading, driftNote } from "../summary.js";
import type { EvalMetrics, FixtureValidation, ImpactNoteExpectation, ManagedTransport } from "../types.js";

const HELP_ARGV = ["tree", "tree", "--help"];
const SELECTOR_ARGV = ["tree", "tree", "/domains/payments"];
const BYO_ROUTE_ARGV = [
  "--json",
  "context",
  "route",
  "--provider",
  "codex",
  "--pathless",
  "--session-candidate",
  "eval-receipt",
];
const BYO_ACTIVATION_ARGV = ["--json", "context", "snapshot", "--candidate", "candidate-byo-read-eval"];
const LEGACY_BYO_ACTIVATION_ARGV = [
  "--json",
  "tree",
  "read",
  "--team",
  "team-byo-read-eval",
  "--snapshot",
  "/tmp/read-task/context-tree",
];
const BYO_SELECTOR_ARGV = ["tree", "tree", "--no-pull", "systems/server/auth"];
const EXACT_COMMIT = "a".repeat(40);
const TEST_SOURCE_AUTHORITY = {
  allowedNodePaths: [
    "NODE.md",
    "domains/payments/NODE.md",
    "product/billing/rollout-policy/NODE.md",
    "product/release/rollout-policy/NODE.md",
    "systems/server/auth/scopes/NODE.md",
  ],
  exactCommit: EXACT_COMMIT,
  repository: "https://github.com/example/context-tree.git",
} as const;
const EXPECTED_FACT = "payments runbook anchor";
const JWT_EXPECTED_FACTS = [
  "User JWT auth is the unified authorization surface.",
  "Route scopes must be checked against live organization membership before cross-org actions.",
  "HTTP routes must follow the repo path conventions document before auth or multi-org changes.",
] as const;

const VALID_FIXTURE: FixtureValidation = {
  domainNodeCount: 2,
  errors: [],
  minDepthOk: true,
  ok: true,
  requiredFilesOk: true,
  verifyResult: null,
};

function skillReadEvent(): unknown {
  return {
    event: {
      command: "sed -n 1,200p skills/first-tree-read/SKILL.md",
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

function firstTreeCall(argv: readonly string[], extra: Record<string, unknown> = {}): unknown {
  return {
    argv: [...argv],
    phase: "model",
    type: "first_tree_call",
    ...extra,
  };
}

function firstTreeResult(argv: readonly string[], exitCode: number, extra: Record<string, unknown> = {}): unknown {
  return {
    argv: [...argv],
    exitCode,
    phase: "model",
    type: "first_tree_result",
    ...extra,
  };
}

function managedMessage(
  body: string,
  argv: readonly string[] = ["chat", "send", "gandy2025", "-F", "reply.md"],
): unknown[] {
  return [firstTreeCall(argv, { body }), firstTreeResult(argv, 0)];
}

function managedStatus(body: string): unknown[] {
  const argv = ["chat", "update", "--description", "-"];
  return [firstTreeCall(argv, { body }), firstTreeResult(argv, 0)];
}

function metrics(events: readonly unknown[]): EvalMetrics {
  return deriveMetrics(events, VALID_FIXTURE, 0, [EXPECTED_FACT], { mode: "absent" }, "send");
}

function impactMetrics(
  events: readonly unknown[],
  expectation: ImpactNoteExpectation,
  managedTransport: ManagedTransport = "send",
): EvalMetrics {
  return deriveMetrics(events, VALID_FIXTURE, 0, [EXPECTED_FACT], expectation, managedTransport);
}

describe("first-tree-read metrics pass criteria", () => {
  it("passes trigger cases only when skill read, facts, help, selector, and command results are all OK", () => {
    const nativeOnly = metrics([
      skillReadEvent(),
      firstTreeCall(HELP_ARGV),
      firstTreeResult(HELP_ARGV, 0),
      firstTreeCall(SELECTOR_ARGV),
      firstTreeResult(SELECTOR_ARGV, 0),
      assistantTextEvent(`The tree says ${EXPECTED_FACT}.`),
    ]);
    const result = metrics([
      skillReadEvent(),
      firstTreeCall(HELP_ARGV),
      firstTreeResult(HELP_ARGV, 0),
      firstTreeCall(SELECTOR_ARGV),
      firstTreeResult(SELECTOR_ARGV, 0),
      ...managedMessage(`The tree says ${EXPECTED_FACT}.`),
    ]);

    expect(result.skillFileReadObserved).toBe(true);
    expect(result.expectedFactsObserved).toBe(true);
    expect(result.helpSucceeded).toBe(true);
    expect(result.selectionSucceeded).toBe(true);
    expect(result.modelFirstTreeCommandsOk).toBe(true);
    expect(nativeOnly.managedFinalTransportOk).toBe(false);
    expect(casePassed(true, nativeOnly)).toBe(false);
    expect(result.managedFinalTransportOk).toBe(true);
    expect(casePassed(true, result)).toBe(true);
  });

  it("passes BYO cases only for one ordered SCOPE route and exact detached no-pull snapshot", () => {
    const result = metrics([
      skillReadEvent(),
      firstTreeCall(BYO_ROUTE_ARGV),
      firstTreeResult(BYO_ROUTE_ARGV, 0),
      firstTreeCall(BYO_ACTIVATION_ARGV),
      firstTreeResult(BYO_ACTIVATION_ARGV, 0, { exactCommit: EXACT_COMMIT }),
      firstTreeCall(HELP_ARGV),
      firstTreeResult(HELP_ARGV, 0),
      firstTreeCall(BYO_SELECTOR_ARGV),
      firstTreeResult(BYO_SELECTOR_ARGV, 0, { actualHead: EXACT_COMMIT, detachedHead: true }),
      assistantTextEvent(`The tree says ${EXPECTED_FACT}.`),
    ]);

    expect(result.readRouteCalls).toBe(1);
    expect(result.readRouteSucceeded).toBe(true);
    expect(result.readActivationCalls).toBe(1);
    expect(result.readActivationSucceeded).toBe(true);
    expect(result.byoReadSequenceOk).toBe(true);
    expect(result.byoSelectorsNoPull).toBe(true);
    expect(result.byoSnapshotDetached).toBe(true);
    expect(result.byoSnapshotExactHeadConsistent).toBe(true);
    expect(casePassed(true, result, "byo")).toBe(true);
  });

  it("fails BYO cases when activation is repeated or selectors can refresh", () => {
    const mutableSelector = ["tree", "tree", "systems/server/auth"];
    const result = metrics([
      skillReadEvent(),
      firstTreeCall(BYO_ROUTE_ARGV),
      firstTreeResult(BYO_ROUTE_ARGV, 0),
      firstTreeCall(BYO_ACTIVATION_ARGV),
      firstTreeResult(BYO_ACTIVATION_ARGV, 0, { exactCommit: EXACT_COMMIT }),
      firstTreeCall(BYO_ACTIVATION_ARGV),
      firstTreeResult(BYO_ACTIVATION_ARGV, 0, { exactCommit: EXACT_COMMIT }),
      firstTreeCall(HELP_ARGV),
      firstTreeResult(HELP_ARGV, 0),
      firstTreeCall(mutableSelector),
      firstTreeResult(mutableSelector, 0, { actualHead: EXACT_COMMIT, detachedHead: true }),
      assistantTextEvent(`The tree says ${EXPECTED_FACT}.`),
    ]);

    expect(result.readActivationCalls).toBe(2);
    expect(result.readActivationSucceeded).toBe(false);
    expect(result.byoSelectorsNoPull).toBe(false);
    expect(casePassed(true, result, "byo")).toBe(false);
  });

  it("rejects the legacy tree read activation sequence for BYO cases", () => {
    const result = metrics([
      skillReadEvent(),
      firstTreeCall(LEGACY_BYO_ACTIVATION_ARGV),
      firstTreeResult(LEGACY_BYO_ACTIVATION_ARGV, 0, { exactCommit: EXACT_COMMIT }),
      firstTreeCall(HELP_ARGV),
      firstTreeResult(HELP_ARGV, 0),
      firstTreeCall(BYO_SELECTOR_ARGV),
      firstTreeResult(BYO_SELECTOR_ARGV, 0, { actualHead: EXACT_COMMIT, detachedHead: true }),
      assistantTextEvent(`The tree says ${EXPECTED_FACT}.`),
    ]);

    expect(result.readRouteSucceeded).toBe(false);
    expect(result.readActivationSucceeded).toBe(false);
    expect(result.legacyReadActivationCalls).toBe(1);
    expect(result.byoReadSequenceOk).toBe(false);
    expect(casePassed(true, result, "byo")).toBe(false);
  });

  it("rejects a legacy tree read activation even when the current BYO sequence also succeeds", () => {
    const result = metrics([
      skillReadEvent(),
      firstTreeCall(LEGACY_BYO_ACTIVATION_ARGV),
      firstTreeResult(LEGACY_BYO_ACTIVATION_ARGV, 0, { exactCommit: EXACT_COMMIT }),
      firstTreeCall(BYO_ROUTE_ARGV),
      firstTreeResult(BYO_ROUTE_ARGV, 0),
      firstTreeCall(BYO_ACTIVATION_ARGV),
      firstTreeResult(BYO_ACTIVATION_ARGV, 0, { exactCommit: EXACT_COMMIT }),
      firstTreeCall(HELP_ARGV),
      firstTreeResult(HELP_ARGV, 0),
      firstTreeCall(BYO_SELECTOR_ARGV),
      firstTreeResult(BYO_SELECTOR_ARGV, 0, { actualHead: EXACT_COMMIT, detachedHead: true }),
      assistantTextEvent(`The tree says ${EXPECTED_FACT}.`),
    ]);

    expect(result.readRouteSucceeded).toBe(true);
    expect(result.readActivationSucceeded).toBe(true);
    expect(result.legacyReadActivationCalls).toBe(1);
    expect(result.byoReadSequenceOk).toBe(false);
    expect(casePassed(true, result, "byo")).toBe(false);
  });

  it("fails trigger cases when facts are present but help is missing", () => {
    const result = metrics([
      skillReadEvent(),
      firstTreeCall(SELECTOR_ARGV),
      firstTreeResult(SELECTOR_ARGV, 0),
      assistantTextEvent(`The tree says ${EXPECTED_FACT}.`),
    ]);

    expect(result.expectedFactsObserved).toBe(true);
    expect(result.helpSucceeded).toBe(false);
    expect(result.selectionSucceeded).toBe(true);
    expect(result.modelFirstTreeCommandsOk).toBe(true);
    expect(casePassed(true, result)).toBe(false);
  });

  it("fails trigger cases when help succeeds but no selector succeeds", () => {
    const result = metrics([
      skillReadEvent(),
      firstTreeCall(HELP_ARGV),
      firstTreeResult(HELP_ARGV, 0),
      firstTreeCall(SELECTOR_ARGV),
      assistantTextEvent(`The tree says ${EXPECTED_FACT}.`),
    ]);

    expect(result.helpSucceeded).toBe(true);
    expect(result.selectionSucceeded).toBe(false);
    expect(result.modelFirstTreeCommandsOk).toBe(true);
    expect(casePassed(true, result)).toBe(false);
  });

  it("fails trigger cases when any model-phase first-tree result is non-zero, including later selector failures", () => {
    const result = metrics([
      skillReadEvent(),
      firstTreeCall(HELP_ARGV),
      firstTreeResult(HELP_ARGV, 0),
      firstTreeCall(SELECTOR_ARGV),
      firstTreeResult(SELECTOR_ARGV, 0),
      firstTreeCall(["tree", "tree", "/domains/payments/deep-dive"]),
      firstTreeResult(["tree", "tree", "/domains/payments/deep-dive"], 2),
      assistantTextEvent(`The tree says ${EXPECTED_FACT}.`),
    ]);

    expect(result.helpSucceeded).toBe(true);
    expect(result.selectionSucceeded).toBe(true);
    expect(result.modelFirstTreeCommandsOk).toBe(false);
    expect(casePassed(true, result)).toBe(false);
  });

  it("recognizes strict expected fact concepts in translated or paraphrased final answers", () => {
    const result = deriveMetrics(
      [
        skillReadEvent(),
        firstTreeCall(HELP_ARGV),
        firstTreeResult(HELP_ARGV, 0),
        firstTreeCall(["tree", "tree", "systems/server/auth"]),
        firstTreeResult(["tree", "tree", "systems/server/auth"], 0),
        ...managedMessage(`JWT auth routes 要遵守这些约束：
- User JWT 是统一授权面。
- Route scopes 必须结合当前 live organization membership checks。
- HTTP routes 和 multi-org 改动必须遵循 docs/development/http-path-conventions.md。`),
      ],
      VALID_FIXTURE,
      0,
      JWT_EXPECTED_FACTS,
      { mode: "absent" },
      "send",
    );

    expect(result.expectedFactHits).toEqual([...JWT_EXPECTED_FACTS]);
    expect(result.expectedFactsObserved).toBe(true);
    expect(casePassed(true, result)).toBe(true);
  });

  it("recognizes the user JWT authorization surface when phrased as single authorization surface", () => {
    const result = deriveMetrics(
      [
        skillReadEvent(),
        firstTreeCall(HELP_ARGV),
        firstTreeResult(HELP_ARGV, 0),
        firstTreeCall(["tree", "tree", "systems/server/auth"]),
        firstTreeResult(["tree", "tree", "systems/server/auth"], 0),
        assistantTextEvent(`JWT auth routes should:
- Use user JWT auth as the single authorization surface.
- Check route scopes against live organization membership before cross-org actions.
- Follow docs/development/http-path-conventions.md before auth or multi-org route changes.`),
      ],
      VALID_FIXTURE,
      0,
      JWT_EXPECTED_FACTS,
    );

    expect(result.expectedFactHits).toEqual([...JWT_EXPECTED_FACTS]);
    expect(result.expectedFactsObserved).toBe(true);
  });

  it("recognizes the natural unified user JWT authorization surface word order", () => {
    const result = deriveMetrics(
      [
        skillReadEvent(),
        firstTreeCall(HELP_ARGV),
        firstTreeResult(HELP_ARGV, 0),
        firstTreeCall(["tree", "tree", "systems/server/auth"]),
        firstTreeResult(["tree", "tree", "systems/server/auth"], 0),
        assistantTextEvent(`JWT auth routes should:
- Use the unified user JWT authorization surface.
- Check route scopes against live organization membership before cross-org actions.
- Follow the repository's HTTP path conventions before auth or multi-org route changes.`),
      ],
      VALID_FIXTURE,
      0,
      JWT_EXPECTED_FACTS,
    );

    expect(result.expectedFactHits).toEqual([...JWT_EXPECTED_FACTS]);
    expect(result.expectedFactsObserved).toBe(true);
  });

  it("does not count isolated terms as expected fact concepts", () => {
    const result = deriveMetrics(
      [
        skillReadEvent(),
        firstTreeCall(HELP_ARGV),
        firstTreeResult(HELP_ARGV, 0),
        firstTreeCall(["tree", "tree", "systems/server/auth"]),
        firstTreeResult(["tree", "tree", "systems/server/auth"], 0),
        assistantTextEvent("This only mentions User JWT, route scopes, and path conventions as loose keywords."),
      ],
      VALID_FIXTURE,
      0,
      JWT_EXPECTED_FACTS,
    );

    expect(result.expectedFactHits).toEqual([]);
    expect(result.expectedFactsObserved).toBe(false);
    expect(casePassed(true, result)).toBe(false);
  });

  it("fails bypassed trigger cases when facts appear without a first-tree tree tree selector command", () => {
    const result = metrics([
      skillReadEvent(),
      firstTreeCall(HELP_ARGV),
      firstTreeResult(HELP_ARGV, 0),
      assistantTextEvent(`The tree says ${EXPECTED_FACT}.`),
    ]);

    expect(result.expectedFactsObserved).toBe(true);
    expect(result.helpSucceeded).toBe(true);
    expect(result.selectionSucceeded).toBe(false);
    expect(casePassed(true, result)).toBe(false);
  });

  it("maps trigger process failures into deterministic grading output", () => {
    const result = metrics([
      skillReadEvent(),
      firstTreeCall(HELP_ARGV),
      firstTreeResult(HELP_ARGV, 0),
      assistantTextEvent(`The tree says ${EXPECTED_FACT}.`),
    ]);
    const grading = buildGrading("read-grading-test", result, true, casePassed(true, result));

    expect(grading.passed).toBe(false);
    expect(grading.scores).toEqual({
      outcome_pass: true,
      process_pass: false,
      risk_pass: true,
      routing_pass: true,
    });
    expect(gradingFailureMessages(grading)[0]).toContain("process_pass=false");
  });

  it("keeps non-trigger cases green when no skill hit, facts, or commands occur", () => {
    const result = metrics([assistantTextEvent("This answer stays outside the Context Tree topic.")]);

    expect(result.skillHit).toBe(false);
    expect(result.expectedFactHits).toEqual([]);
    expect(result.firstTreeCalls).toBe(0);
    expect(result.firstTreeCommandResults).toEqual([]);
    expect(result.modelFirstTreeCommandsOk).toBe(true);
    expect(casePassed(false, result)).toBe(true);
  });

  it("fails non-trigger cases on any model-phase first-tree command usage or non-zero result", () => {
    const usageResult = metrics([firstTreeCall(HELP_ARGV)]);
    const nonZeroResult = metrics([firstTreeResult(["doctor"], 1)]);

    expect(usageResult.skillHit).toBe(true);
    expect(casePassed(false, usageResult)).toBe(false);
    expect(nonZeroResult.skillHit).toBe(true);
    expect(nonZeroResult.modelFirstTreeCommandsOk).toBe(false);
    expect(casePassed(false, nonZeroResult)).toBe(false);
  });

  it("accepts one exact-version English impact note in a managed chat body", () => {
    const body = `JWT routes must enforce the tree constraints.

> How Context Tree affected this work\\
> **Options narrowed:** The organization-isolation rule ruled out a global shared index.\\
> Context Tree source: [Organization isolation](https://github.com/example/context-tree/blob/${EXACT_COMMIT}/systems/server/auth/scopes/NODE.md)`;
    const result = impactMetrics(managedMessage(body), {
      effect: "constrained",
      language: "en",
      mode: "present",
      sourceAuthority: TEST_SOURCE_AUTHORITY,
      sourceCount: { max: 1, min: 1 },
    });

    expect(result.impactNoteBehaviorOk).toBe(true);
    expect(result.impactNoteCount).toBe(1);
    expect(result.impactNoteBlankLineBefore).toBe(true);
    expect(result.impactNoteLogicalLinesOk).toBe(true);
    expect(result.impactNoteExactLinksOk).toBe(true);
    expect(result.impactNoteSummaryObjectiveOk).toBe(true);
    expect(result.impactNoteSourceLabels).toEqual(["Organization isolation"]);
    expect(result.impactNoteMetadataFree).toBe(true);
    expect(result.managedFinalTransportOk).toBe(true);
  });

  it("rejects legacy or malformed impact-note scaffolding", () => {
    const body = `JWT routes must enforce the tree constraints.

> **Context Tree impact · Options narrowed**\\
> The organization-isolation rule ruled out a global shared index.\\
> **Source** · [Organization isolation](https://github.com/example/context-tree/blob/${EXACT_COMMIT}/systems/server/auth/scopes/NODE.md)`;
    const result = impactMetrics(managedMessage(body), {
      effect: "constrained",
      language: "en",
      mode: "present",
      sourceAuthority: TEST_SOURCE_AUTHORITY,
      sourceCount: { max: 1, min: 1 },
    });

    const absentResult = impactMetrics(managedMessage(body), { mode: "absent" });
    const mixedResult = impactMetrics(
      managedMessage(`JWT routes must enforce the tree constraints.

> **Context Tree impact · Options narrowed**\\
> **Options narrowed:** The organization-isolation rule ruled out a global shared index.\\
> Context Tree source: [Organization isolation](https://github.com/example/context-tree/blob/${EXACT_COMMIT}/systems/server/auth/scopes/NODE.md)`),
      {
        effect: "constrained",
        language: "en",
        mode: "present",
        sourceAuthority: TEST_SOURCE_AUTHORITY,
        sourceCount: { max: 1, min: 1 },
      },
    );
    const malformedResults = [
      `> **Context Tree impact · Options narrowed**
> The organization-isolation rule ruled out a global shared index.\\
> **Source** · [Organization isolation](https://github.com/example/context-tree/blob/${EXACT_COMMIT}/systems/server/auth/scopes/NODE.md)`,
      `> **Context Tree impact**\\
> **Options narrowed:** The organization-isolation rule ruled out a global shared index.\\
> Context Tree source: [Organization isolation](https://github.com/example/context-tree/blob/${EXACT_COMMIT}/systems/server/auth/scopes/NODE.md)`,
      `> How Context Tree affected this work
> **Options narrowed:** The organization-isolation rule ruled out a global shared index.\\
> Context Tree source: [Organization isolation](https://github.com/example/context-tree/blob/${EXACT_COMMIT}/systems/server/auth/scopes/NODE.md)`,
      `> How Context Tree affected this work${"  "}
> **Options narrowed:** The organization-isolation rule ruled out a global shared index.\\
> Context Tree source: [Organization isolation](https://github.com/example/context-tree/blob/${EXACT_COMMIT}/systems/server/auth/scopes/NODE.md)`,
      `> **Context Tree impact · Options narrowed**${"  "}
> The organization-isolation rule ruled out a global shared index.\\
> **Source** · [Organization isolation](https://github.com/example/context-tree/blob/${EXACT_COMMIT}/systems/server/auth/scopes/NODE.md)`,
    ].map((note) => impactMetrics(managedMessage(`Answer.\n\n${note}`), { mode: "absent" }));

    expect(result.impactNoteCount).toBe(1);
    expect(result.impactNoteBehaviorOk).toBe(false);
    expect(absentResult.impactNoteCount).toBe(1);
    expect(absentResult.impactNoteBehaviorOk).toBe(false);
    expect(mixedResult.impactNoteCount).toBe(1);
    expect(mixedResult.impactNoteBehaviorOk).toBe(false);
    expect(malformedResults.every((item) => item.impactNoteCount === 1)).toBe(true);
    expect(malformedResults.every((item) => item.impactNoteBehaviorOk === false)).toBe(true);
  });

  it("makes material trigger cases fail until the final visible note satisfies the behavior contract", () => {
    const expectation: ImpactNoteExpectation = {
      effect: "constrained",
      language: "en",
      mode: "present",
      sourceAuthority: TEST_SOURCE_AUTHORITY,
      sourceCount: { max: 1, min: 1 },
    };
    const baseEvents = [
      skillReadEvent(),
      firstTreeCall(HELP_ARGV),
      firstTreeResult(HELP_ARGV, 0),
      firstTreeCall(SELECTOR_ARGV),
      firstTreeResult(SELECTOR_ARGV, 0),
      assistantTextEvent(`The tree says ${EXPECTED_FACT}.`),
    ];
    const note = `Answer.

> How Context Tree affected this work\\
> **Options narrowed:** The payment rule narrowed the implementation boundary.\\
> Context Tree source: [Payments](https://github.com/example/context-tree/blob/${EXACT_COMMIT}/domains/payments/NODE.md)`;
    const withoutNote = impactMetrics(
      [...baseEvents, ...managedMessage(`The tree says ${EXPECTED_FACT}. Final answer without the note.`)],
      expectation,
    );
    const nativeOnly = impactMetrics([...baseEvents, assistantTextEvent(note)], expectation);
    const withNote = impactMetrics(
      [...baseEvents, ...managedMessage(`The tree says ${EXPECTED_FACT}.\n\n${note}`)],
      expectation,
    );

    expect(withoutNote.impactNoteBehaviorOk).toBe(false);
    expect(casePassed(true, withoutNote)).toBe(false);
    expect(nativeOnly.impactNoteBehaviorOk).toBe(true);
    expect(nativeOnly.managedFinalTransportOk).toBe(false);
    expect(casePassed(true, nativeOnly)).toBe(false);
    expect(withNote.impactNoteBehaviorOk).toBe(true);
    expect(withNote.managedFinalTransportOk).toBe(true);
    expect(casePassed(true, withNote)).toBe(true);
  });

  it("rejects duplicate notes, mutable links, and visible receipt metadata", () => {
    const note = `> How Context Tree affected this work\\
> **Options narrowed:** The rule ruled out a shared index.\\
> Context Tree source: [Organization isolation](https://github.com/example/context-tree/blob/main/systems/server/auth/scopes/NODE.md)`;
    const result = impactMetrics(
      [assistantTextEvent(`Answer.\n\n${note}\n\n${note}\n\n{ "contextDecision": { "effect": "constrained" } }`)],
      {
        effect: "constrained",
        language: "en",
        mode: "present",
        sourceAuthority: TEST_SOURCE_AUTHORITY,
        sourceCount: { max: 1, min: 1 },
      },
    );

    expect(result.impactNoteCount).toBe(2);
    expect(result.impactNoteExactLinksOk).toBe(false);
    expect(result.impactNoteMetadataFree).toBe(false);
    expect(result.impactNoteBehaviorOk).toBe(false);
  });

  it("rejects credential-bearing source links and first-person impact summaries", () => {
    const result = impactMetrics(
      [
        assistantTextEvent(`Answer.

> How Context Tree affected this work\\
> **Options narrowed:** I used Context Tree to rule out a shared index.\\
> Context Tree source: [Organization isolation](https://x-access-token:secret@github.com/example/context-tree/blob/${EXACT_COMMIT}/systems/server/auth/scopes/NODE.md)`),
      ],
      {
        effect: "constrained",
        language: "en",
        mode: "present",
        sourceAuthority: TEST_SOURCE_AUTHORITY,
        sourceCount: { max: 1, min: 1 },
      },
    );

    expect(result.impactNoteExactLinksOk).toBe(false);
    expect(result.impactNoteSummaryObjectiveOk).toBe(false);
    expect(result.impactNoteBehaviorOk).toBe(false);
  });

  it.each([
    "I ruled out the shared index because of the organization-isolation rule.",
    "We ruled out the shared index because of the organization-isolation rule.",
    "Our review ruled out the shared index because of the organization-isolation rule.",
    "The organization-isolation rule led us away from the shared index.",
    "Us reviewers ruled out the shared index because of the organization-isolation rule.",
    "The organization-isolation rule allowed me to choose the local index.",
    "The rule shows I should choose tenant-local storage.",
    "根据我们的评审，组织隔离规则排除了共享索引。",
    "根据我的评审，组织隔离规则排除了共享索引。",
    "The organization-isolation rule ruled out the shared index. Then the approach changed.",
    "The organization-isolation rule ruled out the shared index. another option remains.",
    "The organization-isolation rule ruled out the shared index. **This remains unresolved.**",
  ])("rejects non-objective or multi-sentence impact summaries: %s", (summary) => {
    const result = impactMetrics(
      [
        assistantTextEvent(`Answer.

> How Context Tree affected this work\\
> **Options narrowed:** ${summary}\\
> Context Tree source: [Organization isolation](https://github.com/example/context-tree/blob/${EXACT_COMMIT}/systems/server/auth/scopes/NODE.md)`),
      ],
      {
        effect: "constrained",
        language: "en",
        mode: "present",
        sourceAuthority: TEST_SOURCE_AUTHORITY,
        sourceCount: { max: 1, min: 1 },
      },
    );

    expect(result.impactNoteSummaryObjectiveOk).toBe(false);
    expect(result.impactNoteBehaviorOk).toBe(false);
  });

  it.each([
    "The U.S. isolation rule ruled out the shared index.",
    "The U.S. Organization rule ruled out the shared index.",
    "The I/O isolation rule ruled out shared storage.",
    "The i-012345 storage rule ruled out shared storage.",
    "The ME residency rule ruled out a shared index.",
    "The me-central-1 residency rule ruled out a shared index.",
    "The US residency rule ruled out a shared index.",
    "The us-east-1 residency rule ruled out a shared index.",
    "Phase I narrowed the acceptable rollout scope.",
  ])("does not treat abbreviations or phase labels as first person or sentence boundaries: %s", (summary) => {
    const result = impactMetrics(
      [
        assistantTextEvent(`Answer.

> How Context Tree affected this work\\
> **Options narrowed:** ${summary}\\
> Context Tree source: [Organization isolation](https://github.com/example/context-tree/blob/${EXACT_COMMIT}/systems/server/auth/scopes/NODE.md)`),
      ],
      {
        effect: "constrained",
        language: "en",
        mode: "present",
        sourceAuthority: TEST_SOURCE_AUTHORITY,
        sourceCount: { max: 1, min: 1 },
      },
    );

    expect(result.impactNoteSummaryObjectiveOk).toBe(true);
    expect(result.impactNoteBehaviorOk).toBe(true);
  });

  it("rejects contextDecision metadata in successful chat transport while allowing unrelated metadata", () => {
    const body = `Answer.

> How Context Tree affected this work\\
> **Options narrowed:** The organization-isolation rule ruled out a global shared index.\\
> Context Tree source: [Organization isolation](https://github.com/example/context-tree/blob/${EXACT_COMMIT}/systems/server/auth/scopes/NODE.md)`;
    const expectation: ImpactNoteExpectation = {
      effect: "constrained",
      language: "en",
      mode: "present",
      sourceAuthority: TEST_SOURCE_AUTHORITY,
      sourceCount: { max: 1, min: 1 },
    };
    const receiptArgv = [
      "chat",
      "send",
      "gandy2025",
      "-F",
      "reply.md",
      "--metadata",
      JSON.stringify({ contextDecision: { effect: "constrained" }, mentionIds: ["member-1"] }),
    ];
    const unrelatedArgv = [
      "chat",
      "send",
      "gandy2025",
      "-F",
      "reply.md",
      "-m",
      JSON.stringify({ mentionIds: ["member-1"] }),
    ];
    const withReceipt = impactMetrics(managedMessage(body, receiptArgv), expectation);
    const withUnrelatedMetadata = impactMetrics(managedMessage(body, unrelatedArgv), expectation);

    expect(withReceipt.impactNoteMetadataFree).toBe(false);
    expect(withReceipt.impactNoteBehaviorOk).toBe(false);
    expect(withUnrelatedMetadata.impactNoteMetadataFree).toBe(true);
    expect(withUnrelatedMetadata.impactNoteBehaviorOk).toBe(true);
  });

  it("rejects exact-looking source links outside the selected repository, commit, or allowed paths", () => {
    const expectation: ImpactNoteExpectation = {
      effect: "constrained",
      language: "en",
      mode: "present",
      sourceAuthority: {
        allowedNodePaths: ["systems/server/auth/scopes/NODE.md"],
        exactCommit: EXACT_COMMIT,
        repository: "https://github.com/example/context-tree.git",
      },
      sourceCount: { max: 1, min: 1 },
    };
    const noteFor = (url: string) =>
      assistantTextEvent(`Answer.

> How Context Tree affected this work\\
> **Options narrowed:** The organization-isolation rule ruled out a global shared index.\\
> Context Tree source: [Organization isolation](${url})`);
    const invalidUrls = [
      `https://evil.example/example/context-tree/blob/${EXACT_COMMIT}/systems/server/auth/scopes/NODE.md`,
      `https://github.com/another/context-tree/blob/${EXACT_COMMIT}/systems/server/auth/scopes/NODE.md`,
      `https://github.com/example/context-tree/blob/${"b".repeat(40)}/systems/server/auth/scopes/NODE.md`,
      `https://github.com/example/context-tree/blob/${EXACT_COMMIT}/systems/server/auth/unknown/NODE.md`,
    ];

    for (const url of invalidUrls) {
      const result = impactMetrics([noteFor(url)], expectation);
      expect(result.impactNoteExactLinksOk).toBe(true);
      expect(result.impactNoteSourceAuthorityOk).toBe(false);
      expect(result.impactNoteBehaviorOk).toBe(false);
    }
  });

  it("requires the note to end the final successful managed message", () => {
    const note = `> How Context Tree affected this work\\
> **Options narrowed:** The organization-isolation rule ruled out a global shared index.\\
> Context Tree source: [Organization isolation](https://github.com/example/context-tree/blob/${EXACT_COMMIT}/systems/server/auth/scopes/NODE.md)`;
    const expectation: ImpactNoteExpectation = {
      effect: "constrained",
      language: "en",
      mode: "present",
      sourceAuthority: TEST_SOURCE_AUTHORITY,
      sourceCount: { max: 1, min: 1 },
    };
    const trailingProse = impactMetrics([assistantTextEvent(`Answer.\n\n${note}\n\nMore detail.`)], expectation);
    const progressOnly = impactMetrics(
      [...managedMessage(`Progress.\n\n${note}`), ...managedMessage("Final answer without the note.")],
      expectation,
    );
    const finalOnly = impactMetrics(
      [...managedMessage("Progress without the note."), ...managedMessage(`Final answer.\n\n${note}`)],
      expectation,
    );
    const modelProgressDuplicate = impactMetrics(
      [assistantTextEvent(`Progress.\n\n${note}`), ...managedMessage(`Final answer.\n\n${note}`)],
      expectation,
    );
    const currentStateDuplicate = impactMetrics(
      [...managedStatus(`Progress.\n\n${note}`), ...managedMessage(`Final answer.\n\n${note}`)],
      expectation,
    );

    expect(trailingProse.impactNoteAtFinalEnd).toBe(false);
    expect(trailingProse.impactNoteBehaviorOk).toBe(false);
    expect(progressOnly.impactNoteAtFinalEnd).toBe(false);
    expect(progressOnly.impactNoteBehaviorOk).toBe(false);
    expect(finalOnly.impactNoteAtFinalEnd).toBe(true);
    expect(finalOnly.impactNoteBehaviorOk).toBe(true);
    expect(modelProgressDuplicate.impactNoteCount).toBe(2);
    expect(modelProgressDuplicate.impactNoteBehaviorOk).toBe(false);
    expect(currentStateDuplicate.impactNoteCount).toBe(2);
    expect(currentStateDuplicate.impactNoteBehaviorOk).toBe(false);
  });

  it("uses the case transport contract rather than deriving transport from the impact effect", () => {
    const body = `需要你决定如何处理冲突。

> Context Tree 如何影响本次工作\\
> **发现约束冲突**：固定发布日期与发布前安全审计无法同时满足，取舍仍待决定。\\
> Context Tree 来源：[Rollout Policy](https://github.com/example/context-tree/blob/${EXACT_COMMIT}/product/release/rollout-policy/NODE.md)`;
    const expectation: ImpactNoteExpectation = {
      effect: "conflicted",
      language: "zh",
      mode: "present",
      sourceAuthority: TEST_SOURCE_AUTHORITY,
      sourceCount: { max: 1, min: 1 },
    };
    const sentForBlockingCase = impactMetrics(managedMessage(body), expectation, "ask");
    const askedForBlockingCase = impactMetrics(
      managedMessage(body, ["chat", "ask", "gandy2025", "-F", "question.md"]),
      expectation,
      "ask",
    );
    const sentForTerminalCase = impactMetrics(managedMessage(body), expectation, "send");

    expect(sentForBlockingCase.impactNoteBehaviorOk).toBe(true);
    expect(sentForBlockingCase.managedFinalTransportOk).toBe(false);
    // A blocking question must stay decision-self-sufficient: the note never
    // rides an ask body, even when the ask is the correct final transport.
    expect(askedForBlockingCase.impactNoteBehaviorOk).toBe(false);
    expect(askedForBlockingCase.impactNoteOutsideBlockingAsk).toBe(false);
    expect(askedForBlockingCase.managedFinalTransportOk).toBe(true);
    expect(sentForTerminalCase.impactNoteBehaviorOk).toBe(true);
    expect(sentForTerminalCase.impactNoteOutsideBlockingAsk).toBe(true);
    expect(sentForTerminalCase.managedFinalTransportOk).toBe(true);
  });

  it("rejects the superseded bolded scaffolding on the first or third line", () => {
    const link = `[Organization isolation](https://github.com/example/context-tree/blob/${EXACT_COMMIT}/systems/server/auth/scopes/NODE.md)`;
    const note = (first: string, third: string) =>
      `Answer.

${first}\\
> **Options narrowed:** The organization-isolation rule ruled out a global shared index.\\
${third}`;
    const expectation: ImpactNoteExpectation = {
      effect: "constrained",
      language: "en",
      mode: "present",
      sourceAuthority: TEST_SOURCE_AUTHORITY,
      sourceCount: { max: 1, min: 1 },
    };
    const plain = impactMetrics(
      managedMessage(note("> How Context Tree affected this work", `> Context Tree source: ${link}`)),
      expectation,
    );
    const boldFirstLine = impactMetrics(
      managedMessage(note("> **How Context Tree affected this work**", `> Context Tree source: ${link}`)),
      expectation,
    );
    const boldSourceLabel = impactMetrics(
      managedMessage(note("> How Context Tree affected this work", `> **Context Tree source:** ${link}`)),
      expectation,
    );

    // Only the effect label carries emphasis; the fixed scaffolding is plain.
    expect(plain.impactNoteBehaviorOk).toBe(true);
    expect(boldFirstLine.impactNoteBehaviorOk).toBe(false);
    expect(boldSourceLabel.impactNoteBehaviorOk).toBe(false);
  });

  it("reports the transport a case actually requires, not a fixed one", () => {
    const body = `Answer.

> How Context Tree affected this work\\
> **Options narrowed:** The isolation rule ruled out a shared index.\\
> Context Tree source: [Organization isolation](https://github.com/example/context-tree/blob/${EXACT_COMMIT}/systems/server/auth/scopes/NODE.md)`;
    const expectation: ImpactNoteExpectation = {
      effect: "constrained",
      language: "en",
      mode: "present",
      sourceAuthority: TEST_SOURCE_AUTHORITY,
      sourceCount: { max: 1, min: 1 },
    };
    // An ask-contract case that wrongly finished with `send` must be told that
    // `ask` was required — the previous fixed wording said the opposite.
    const wrongSendForAskCase = impactMetrics(managedMessage(body), expectation, "ask");
    const askNote = driftNote(wrongSendForAskCase, true, "managed") ?? "";
    expect(askNote).toContain("requires chat ask");
    expect(askNote).not.toContain("requires chat send");
    expect(askNote).toContain("final managed delivery was send");

    // A placement-only failure must name the failing predicate, otherwise every
    // displayed shape/authority field reads true with no visible cause.
    const noteInsideAsk = impactMetrics(
      managedMessage(body, ["chat", "ask", "gandy2025", "-F", "question.md"]),
      expectation,
      "ask",
    );
    expect(noteInsideAsk.impactNoteBehaviorOk).toBe(false);
    expect(driftNote(noteInsideAsk, true, "managed") ?? "").toContain("outside blocking ask=false");
  });

  it.each([
    {
      effectLine: "> **发现约束冲突**： 固定发布日期与发布前安全审计无法同时满足，取舍仍待决定。\\",
      sourceLine: `> Context Tree 来源：[Rollout Policy](https://github.com/example/context-tree/blob/${EXACT_COMMIT}/product/release/rollout-policy/NODE.md)`,
    },
    {
      effectLine: "> **发现约束冲突**：固定发布日期与发布前安全审计无法同时满足，取舍仍待决定。\\",
      sourceLine: `> Context Tree 来源： [Rollout Policy](https://github.com/example/context-tree/blob/${EXACT_COMMIT}/product/release/rollout-policy/NODE.md)`,
    },
  ])("rejects a space after either Chinese scaffolding colon", ({ effectLine, sourceLine }) => {
    const body = `需要你决定如何处理冲突。

> Context Tree 如何影响本次工作\\
${effectLine}
${sourceLine}`;
    const result = impactMetrics(managedMessage(body), {
      effect: "conflicted",
      language: "zh",
      mode: "present",
      sourceAuthority: TEST_SOURCE_AUTHORITY,
      sourceCount: { max: 1, min: 1 },
    });

    expect(result.impactNoteCount).toBe(1);
    expect(result.impactNoteBehaviorOk).toBe(false);
  });

  it("counts identical impact notes from separate BYO assistant messages", () => {
    const note = `Answer.

> How Context Tree affected this work\\
> **Options narrowed:** The organization-isolation rule ruled out a global shared index.\\
> Context Tree source: [Organization isolation](https://github.com/example/context-tree/blob/${EXACT_COMMIT}/systems/server/auth/scopes/NODE.md)`;
    const result = impactMetrics([assistantTextEvent(note), assistantTextEvent(note)], {
      effect: "constrained",
      language: "en",
      mode: "present",
      sourceAuthority: TEST_SOURCE_AUTHORITY,
      sourceCount: { max: 1, min: 1 },
    });

    expect(result.impactNoteCount).toBe(2);
    expect(result.impactNoteBehaviorOk).toBe(false);
  });

  it("rejects a generic middle sentence and credentials elsewhere in the visible response", () => {
    const expectation: ImpactNoteExpectation = {
      effect: "constrained",
      language: "en",
      mode: "present",
      sourceAuthority: TEST_SOURCE_AUTHORITY,
      sourceCount: { max: 1, min: 1 },
      summaryConcepts: [["organization isolation"], ["shared index"], ["ruled out"]],
    };
    const source = `> Context Tree source: [Organization isolation](https://github.com/example/context-tree/blob/${EXACT_COMMIT}/systems/server/auth/scopes/NODE.md)`;
    const generic = impactMetrics(
      [
        assistantTextEvent(`Answer.

> How Context Tree affected this work\\
> **Options narrowed:** Context Tree narrowed the choice.\\
${source}`),
      ],
      expectation,
    );
    const credentialUrls = [
      "https://x-access-token:secret@github.com/example/private",
      "HTTPS://x-access-token:secret@github.com/example/private",
      "hTtPs://x-access-token:secret@github.com/example/private",
      "ssh://git:secret@github.com/example/private",
    ];
    const credentialResults = credentialUrls.map((url) =>
      impactMetrics(
        [
          assistantTextEvent(`See ${url}.

> How Context Tree affected this work\\
> **Options narrowed:** The organization isolation rule ruled out a global shared index.\\
${source}`),
        ],
        expectation,
      ),
    );
    const legalSshUsername = impactMetrics(
      [
        assistantTextEvent(`The binding clone identity is ssh://git@github.com/example/context-tree.git.

> How Context Tree affected this work\\
> **Options narrowed:** The organization isolation rule ruled out a global shared index.\\
${source}`),
      ],
      expectation,
    );

    expect(generic.impactNoteSummaryConceptsOk).toBe(false);
    expect(generic.impactNoteBehaviorOk).toBe(false);
    for (const result of credentialResults) {
      expect(result.impactNoteVisibleUrlsCredentialFree).toBe(false);
      expect(result.impactNoteBehaviorOk).toBe(false);
    }
    expect(legalSshUsername.impactNoteVisibleUrlsCredentialFree).toBe(true);
    expect(legalSshUsername.impactNoteBehaviorOk).toBe(true);
  });

  it("accepts the complete Chinese conflict template only when the tradeoff remains unresolved", () => {
    const expectation: ImpactNoteExpectation = {
      effect: "conflicted",
      language: "zh",
      mode: "present",
      requiredSourceLabels: ["Rollout Policy"],
      sourceAuthority: TEST_SOURCE_AUTHORITY,
      sourceCount: { max: 1, min: 1 },
      summaryConcepts: [["发布日期"], ["安全审计"], ["仍待", "尚未"]],
      summaryForbidden: ["已调整", "已解决"],
    };
    const valid = impactMetrics(
      [
        assistantTextEvent(`不能直接发布。

> Context Tree 如何影响本次工作\\
> **发现约束冲突**：固定发布日期与发布前必须完成安全审计的规则无法同时满足，取舍仍待决定。\\
> Context Tree 来源：[Rollout Policy](https://github.com/example/context-tree/blob/${EXACT_COMMIT}/product/release/rollout-policy/NODE.md)`),
      ],
      expectation,
    );
    const fabricatedResolution = impactMetrics(
      [
        assistantTextEvent(`方案如下。

> Context Tree 如何影响本次工作\\
> **发现约束冲突**：发布日期与安全审计发生冲突，方案已调整并已解决。\\
> Context Tree 来源：[Rollout Policy](https://github.com/example/context-tree/blob/${EXACT_COMMIT}/product/release/rollout-policy/NODE.md)`),
      ],
      expectation,
    );

    expect(valid.impactNoteBehaviorOk).toBe(true);
    expect(valid.impactNoteLanguage).toBe("zh");
    expect(valid.impactNoteSummaryConceptsOk).toBe(true);
    expect(valid.impactNoteSummaryForbiddenOk).toBe(true);
    expect(fabricatedResolution.impactNoteSummaryForbiddenOk).toBe(false);
    expect(fabricatedResolution.impactNoteBehaviorOk).toBe(false);
  });

  it("requires readable root and disambiguated duplicate labels in a three-source note", () => {
    const result = impactMetrics(
      [
        assistantTextEvent(`The rollout is bounded by all three decisions.

> How Context Tree affected this work\\
> **Options narrowed:** The rollout rules require one reviewable scope, audit approval, and core-release stability.\\
> Context Tree sources: [First Tree Read Eval Context](https://github.com/example/context-tree/blob/${EXACT_COMMIT}/NODE.md) · [Release · Rollout Policy](https://github.com/example/context-tree/blob/${EXACT_COMMIT}/product/release/rollout-policy/NODE.md) · [Billing · Rollout Policy](https://github.com/example/context-tree/blob/${EXACT_COMMIT}/product/billing/rollout-policy/NODE.md)`),
      ],
      {
        effect: "constrained",
        language: "en",
        mode: "present",
        requiredSourceLabels: ["First Tree Read Eval Context", "Release · Rollout Policy", "Billing · Rollout Policy"],
        sourceAuthority: TEST_SOURCE_AUTHORITY,
        sourceCount: { max: 3, min: 3 },
      },
    );

    expect(result.impactNoteBehaviorOk).toBe(true);
    expect(result.impactNoteSourceCount).toBe(3);
    expect(result.impactNoteSourceLabels).not.toContain("Node");
  });

  it("keeps navigation-only reads free of impact notes", () => {
    const absent: ImpactNoteExpectation = { mode: "absent" };
    const withoutNote = impactMetrics([assistantTextEvent("systems, domains, operations")], absent);
    const withNote = impactMetrics(
      [
        assistantTextEvent(`systems, domains, operations

> How Context Tree affected this work\\
> **Direction supported:** The root confirmed the domain names.\\
> Context Tree source: [First Tree Read Eval Context](https://github.com/example/context-tree/blob/${EXACT_COMMIT}/NODE.md)`),
      ],
      absent,
    );

    expect(withoutNote.impactNoteBehaviorOk).toBe(true);
    expect(withNote.impactNoteCount).toBe(1);
    expect(withNote.impactNoteBehaviorOk).toBe(false);
  });
});
