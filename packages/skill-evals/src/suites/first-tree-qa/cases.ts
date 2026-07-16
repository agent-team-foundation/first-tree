import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { SkillEvalCase } from "../../core/case-schema.js";
import type { SkillEvalSuiteDefinition } from "../types.js";
import type { FirstTreeQaEvalCase } from "./types.js";
import { QA_CAPABILITIES, QA_SURFACES } from "./types.js";

const FLOOR_CASE_ID = "first-tree-qa-contract-floor";

export const FIRST_TREE_QA_LIVE_GATE_CASES: readonly FirstTreeQaEvalCase[] = [
  {
    briefingMode: "generated-fixture",
    expected: {
      disposition: "no-change",
      planShouldExist: false,
      status: "BLOCKED",
      taskShouldRun: false,
    },
    fixture: { mode: "readiness-blocked" },
    id: "first-tree-qa-readiness-blocked",
    prompt: "Use first-tree-qa to validate the Northstar CLI status behavior in this repository.",
    provider: "codex",
    skill: "first-tree-qa",
    status: "implemented",
    tags: ["complete-harness", "readiness-gate"],
    tier: "gate",
  },
  {
    briefingMode: "generated-fixture",
    expected: {
      disposition: "no-change",
      planShouldExist: true,
      status: "PASS",
      taskShouldRun: true,
    },
    fixture: { mode: "ready" },
    id: "first-tree-qa-ready-then-scope",
    prompt: "Use first-tree-qa to validate the Northstar CLI status behavior in this repository.",
    provider: "codex",
    skill: "first-tree-qa",
    status: "implemented",
    tags: ["complete-harness", "task-scope", "performance"],
    tier: "gate",
  },
];

export const FIRST_TREE_QA_EVAL_CASES: readonly SkillEvalCase[] = [
  {
    briefingMode: "minimal",
    expected: {
      gateCaseIds: FIRST_TREE_QA_LIVE_GATE_CASES.map((evalCase) => evalCase.id),
      lifecycle: ["understand", "qa-ready", "scope", "execute", "report"],
    },
    fixture: {
      capabilities: QA_CAPABILITIES,
      surfaces: QA_SURFACES,
    },
    id: FLOOR_CASE_ID,
    skill: "first-tree-qa",
    status: "implemented",
    tier: "floor",
  },
  ...FIRST_TREE_QA_LIVE_GATE_CASES,
];

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
}

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot(), path), "utf8");
}

export function validateFirstTreeQaFloor(cases: readonly SkillEvalCase[]): readonly string[] {
  const errors: string[] = [];
  const floor = cases.find((evalCase) => evalCase.id === FLOOR_CASE_ID);
  if (floor === undefined) errors.push("missing first-tree-qa floor case");

  const gateIds = cases.filter((evalCase) => evalCase.tier === "gate").map((evalCase) => evalCase.id);
  const expectedGateIds = FIRST_TREE_QA_LIVE_GATE_CASES.map((evalCase) => evalCase.id);
  if (JSON.stringify(gateIds) !== JSON.stringify(expectedGateIds)) {
    errors.push("gate coverage must declare the readiness-blocked and ready-then-scope cases");
  }

  const skill = readRepoFile("skills/first-tree-qa/SKILL.md");
  const packageInstructions = readRepoFile("packages/qa/AGENTS.md");
  const planTemplate = readRepoFile("packages/qa/templates/qa-plan.md");
  const reportTemplate = readRepoFile("packages/qa/templates/qa-report.md");
  const requiredSkillMarkers = [
    "### 1. Understand the product",
    "### 2. Reach `QA READY`",
    "### 3. Scope the task",
    "### 4. Execute and adapt",
    "### 5. Report and improve the quality system",
  ];
  let previous = -1;
  for (const marker of requiredSkillMarkers) {
    const current = skill.indexOf(marker);
    if (current <= previous) errors.push("skill lifecycle markers are missing or out of order");
    previous = current;
  }
  if (!packageInstructions.includes("The skill owns the QA lifecycle")) {
    errors.push("QA package must declare the skill-owned lifecycle boundary");
  }
  if (!planTemplate.includes("Create only after the complete harness is `QA READY`.")) {
    errors.push("QA plan template must be gated on complete-harness readiness");
  }
  for (const disposition of [
    "no-change",
    "candidate-new-case",
    "candidate-case-update",
    "move-to-product-test",
    "move-to-skill-eval",
    "merge-or-retire",
  ]) {
    if (!skill.includes(disposition) || !reportTemplate.includes(disposition)) {
      errors.push("skill and package report template must share all case dispositions");
      break;
    }
  }
  const combined = [skill, packageInstructions, planTemplate].join("\n");
  if (/smallest isolated run cell|run only the services needed|decide run cell shape/iu.test(combined)) {
    errors.push("superseded task-first harness language remains");
  }
  return [...new Set(errors)];
}

export const FIRST_TREE_QA_SUITE: SkillEvalSuiteDefinition = {
  cases: FIRST_TREE_QA_EVAL_CASES,
  coverage: {
    skill: "first-tree-qa",
    tiers: [
      {
        caseIds: [FLOOR_CASE_ID],
        description: "Skill metadata, lifecycle, package boundary, capability matrix, and case disposition contract.",
        status: "implemented",
        tier: "floor",
      },
      {
        caseIds: FIRST_TREE_QA_LIVE_GATE_CASES.map((evalCase) => evalCase.id),
        description: "Complete-harness readiness failure and QA READY before task scoping.",
        status: "implemented",
        tier: "gate",
      },
    ],
  },
  skill: "first-tree-qa",
  validateFloor: validateFirstTreeQaFloor,
};
