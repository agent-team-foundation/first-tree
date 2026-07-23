import type { SkillEvalCase } from "../../core/case-schema.js";
import type { SkillEvalSuiteDefinition } from "../types.js";

const FLOOR_CASE_ID = "audit-context-tree-value-deterministic-floor";
const GATE_CASE_ID = "audit-context-tree-value-manual-codex-history";

export const AUDIT_CONTEXT_TREE_VALUE_CASES: readonly SkillEvalCase[] = [
  {
    briefingMode: "minimal",
    expected: {
      artifacts: ["candidates.jsonl", "evidence.jsonl", "REPORT.md"],
      boundaries: ["manual", "read-only", "local-codex", "authorized-scope"],
    },
    fixture: {
      representativeTrace: true,
      stableReport: true,
    },
    id: FLOOR_CASE_ID,
    skill: "audit-context-tree-value",
    status: "implemented",
    tags: ["deterministic", "schema", "report"],
    tier: "floor",
  },
  {
    briefingMode: "runtime-generated",
    expected: {
      classifications: ["verified", "probable", "unproven"],
      zeroMutation: true,
    },
    fixture: {
      providers: ["codex"],
      scope: "owned-or-explicit",
    },
    id: GATE_CASE_ID,
    prompt:
      "Analyze what value Context Tree created in my agents' work over the past seven days. Use only Chats I own or explicitly authorize, and keep the audit read-only.",
    provider: "codex",
    skill: "audit-context-tree-value",
    status: "planned",
    tags: ["manual-trigger", "passage-level", "planned"],
    tier: "gate",
  },
];

export const AUDIT_CONTEXT_TREE_VALUE_SUITE: SkillEvalSuiteDefinition = {
  cases: AUDIT_CONTEXT_TREE_VALUE_CASES,
  coverage: {
    skill: "audit-context-tree-value",
    tiers: [
      {
        caseIds: [FLOOR_CASE_ID],
        description: "Validate deterministic trace pairing, evidence schema, report output, and trigger boundaries.",
        status: "implemented",
        tier: "floor",
      },
      {
        caseIds: [GATE_CASE_ID],
        description: "Manual passage-level semantic audit over authorized local Codex history.",
        status: "planned",
        tier: "gate",
      },
    ],
  },
  skill: "audit-context-tree-value",
};
