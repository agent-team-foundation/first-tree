import type { JudgeRubricDimension } from "../../core/judge/types.js";
import type {
  QualityArtifactInput,
  QualityCaseDefinition,
  QualityEvalCase,
  QualitySanityFixture,
} from "../quality/types.js";

const WELCOME_TASK_QUALITY_DIMENSIONS: readonly JudgeRubricDimension[] = [
  {
    description: "The proposed first tasks are grounded in the provided repo and Context Tree evidence.",
    key: "evidence_backed",
    threshold: 4,
  },
  {
    description: "The project read stays intentionally narrow while still identifying a concrete relevant entry point.",
    key: "bounded_read",
    threshold: 5,
  },
  {
    description:
      "Exactly two short receipt sentences prove project access and identify a starting seam without presenting the receipt as completed value.",
    key: "receipt_not_value",
    threshold: 4,
  },
  {
    description:
      "The user sees only one or two single-select microtasks and may type a different task, keeping choice cost low.",
    key: "low_choice_cost",
    threshold: 4,
  },
  {
    description: "At least one microtask is explicitly read-only and promises a concrete, reviewable result.",
    key: "read_only_result",
    threshold: 5,
  },
  {
    description:
      "Any local-change option names a precise target/change surface and focused verification; omitting mutation is fully acceptable.",
    key: "qualified_mutation",
    threshold: 4,
  },
  {
    description:
      "The first choice contains no duration estimate, longer-work menu, multi-select, child-chat fan-out, PR prompt, or capability setup.",
    key: "no_premature_expansion",
    threshold: 5,
  },
];

export const FIRST_TREE_WELCOME_QUALITY_CASE: QualityEvalCase = {
  briefingMode: "generated-fixture",
  expected: {
    dimensions: WELCOME_TASK_QUALITY_DIMENSIONS.map((dimension) => dimension.key),
    rubric: "first-tree-welcome bounded microtask quality",
  },
  fixture: {
    artifact: "actual chat ask/final task text produced by welcome row 8",
    gateCaseId: "first-tree-welcome-readable-repo-populated-tree",
    source: "repo and Context Tree evidence from welcome row 8 fixture",
  },
  id: "first-tree-welcome-first-task-quality",
  prompt: "Judge the first-tree-welcome project receipt and initial single-select microtask choice.",
  provider: "codex",
  skill: "first-tree-welcome",
  status: "implemented",
  tags: ["llm-judge", "quality", "first-task"],
  tier: "quality",
};

function dimensionLines(dimensions: readonly JudgeRubricDimension[]): string {
  return dimensions
    .map((dimension) => `- ${dimension.key}: ${dimension.description} Minimum passing score: ${dimension.threshold}.`)
    .join("\n");
}

function buildWelcomeJudgePrompt(input: QualityArtifactInput): string {
  return `You are judging the first-tree-welcome project receipt and initial microtask choice produced by a live gate run.

Return ONLY strict JSON with this shape:
{"scores":{"evidence_backed":1,"bounded_read":1,"receipt_not_value":1,"low_choice_cost":1,"read_only_result":1,"qualified_mutation":1,"no_premature_expansion":1},"reasoning":"one concise paragraph"}

Scores are integers from 1 to 5. Do not include markdown or any extra text.

Rubric:
${dimensionLines(WELCOME_TASK_QUALITY_DIMENSIONS)}

Setup state and evidence:
\`\`\`text
${input.source}
\`\`\`

Actual first-task output from the live gate:
\`\`\`text
${input.artifact}
\`\`\`
`;
}

export const FIRST_TREE_WELCOME_QUALITY_DEFINITION: QualityCaseDefinition = {
  buildJudgePrompt: buildWelcomeJudgePrompt,
  dimensions: WELCOME_TASK_QUALITY_DIMENSIONS,
  evalCase: FIRST_TREE_WELCOME_QUALITY_CASE,
  gateCaseId: "first-tree-welcome-readable-repo-populated-tree",
  title: "first-tree-welcome bounded microtask quality",
};

function sanityInput(name: QualitySanityFixture["name"], artifact: string): QualityArtifactInput {
  return {
    artifact,
    deterministicGatePassed: true,
    gateCaseId: FIRST_TREE_WELCOME_QUALITY_DEFINITION.gateCaseId,
    gateRunRoot: `/tmp/${name}-welcome-gate`,
    gateSummaryJsonPath: `/tmp/${name}-welcome-gate/summary.json`,
    gateSummaryMdPath: `/tmp/${name}-welcome-gate/summary.md`,
    source: [
      "Repo evidence: checkout sessions expire when JWT refresh is skipped.",
      "Context Tree evidence: checkout reliability is a current product priority.",
    ].join("\n"),
  };
}

function judgeOutput(scores: Record<string, number>, reasoning: string): string {
  return JSON.stringify({ reasoning, scores });
}

export const FIRST_TREE_WELCOME_QUALITY_SANITY_FIXTURES: readonly QualitySanityFixture[] = [
  {
    expectedPassed: true,
    input: sanityInput(
      "good",
      [
        "I read the checkout manifest and src/checkout/recovery.ts entry.",
        "The expired-session branch is the clearest focused starting point.",
        "Choose one:",
        "1. Read-only — trace the checkout JWT refresh path and return a 5–8 step call chain with file references.",
        "2. Add the missing case in src/checkout/recovery.test.ts and run pnpm test recovery as the focused check.",
        "Or type a different microtask.",
      ].join("\n"),
    ),
    judgeOutput: judgeOutput(
      {
        bounded_read: 5,
        evidence_backed: 5,
        low_choice_cost: 5,
        no_premature_expansion: 5,
        qualified_mutation: 5,
        read_only_result: 5,
        receipt_not_value: 5,
      },
      "The options are evidence-backed, bounded, and directly verifiable.",
    ),
    name: "good",
  },
  {
    expectedPassed: true,
    input: sanityInput(
      "borderline",
      [
        "I read the checkout README and recovery entry.",
        "The expired-session path is a concrete place to begin.",
        "Read-only — map that path with file references, or type a different microtask.",
      ].join("\n"),
    ),
    judgeOutput: judgeOutput(
      {
        bounded_read: 5,
        evidence_backed: 4,
        low_choice_cost: 4,
        no_premature_expansion: 5,
        qualified_mutation: 4,
        read_only_result: 5,
        receipt_not_value: 4,
      },
      "Exactly meets every threshold without drifting into setup work.",
    ),
    name: "borderline",
  },
  {
    expectedPassed: false,
    input: sanityInput(
      "bad",
      "First connect GitHub, create a Context Tree, then pick several long tasks with hour estimates.",
    ),
    judgeOutput: judgeOutput(
      {
        bounded_read: 1,
        evidence_backed: 2,
        low_choice_cost: 1,
        no_premature_expansion: 1,
        qualified_mutation: 1,
        read_only_result: 1,
        receipt_not_value: 1,
      },
      "This packages setup as the task and is not grounded in the provided evidence.",
    ),
    name: "bad",
  },
];
