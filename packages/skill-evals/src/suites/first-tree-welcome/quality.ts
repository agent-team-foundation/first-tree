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
    description: "Each option is small enough to start immediately and does not balloon into open-ended setup work.",
    key: "bounded",
    threshold: 4,
  },
  {
    description:
      "The options are likely to create visible value for the user rather than merely explaining First Tree.",
    key: "useful",
    threshold: 3,
  },
  {
    description: "The options can be checked against code, tree context, or an observable outcome.",
    key: "verifiable",
    threshold: 3,
  },
  {
    description:
      "The options do not package GitHub auth, repo selection, tree creation, or seed setup as the first task.",
    key: "not_setup_as_task",
    threshold: 5,
  },
];

export const FIRST_TREE_WELCOME_QUALITY_CASE: QualityEvalCase = {
  briefingMode: "generated-fixture",
  expected: {
    dimensions: WELCOME_TASK_QUALITY_DIMENSIONS.map((dimension) => dimension.key),
    rubric: "first-tree-welcome first-task quality",
  },
  fixture: {
    artifact: "actual chat ask/final task text produced by welcome row 8",
    gateCaseId: "first-tree-welcome-readable-repo-populated-tree",
    source: "repo and Context Tree evidence from welcome row 8 fixture",
  },
  id: "first-tree-welcome-first-task-quality",
  prompt: "Judge the quality of first-tree-welcome bounded first-task options from readable repo and tree evidence.",
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
  return `You are judging first-tree-welcome first-task options produced by a live gate run.

Return ONLY strict JSON with this shape:
{"scores":{"evidence_backed":1,"bounded":1,"useful":1,"verifiable":1,"not_setup_as_task":1},"reasoning":"one concise paragraph"}

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
  title: "first-tree-welcome first-task quality",
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
        "1. Trace the checkout JWT refresh path and identify the smallest failing test to add.",
        "2. Compare the Context Tree checkout reliability note with the session refresh implementation and report one concrete fix candidate.",
      ].join("\n"),
    ),
    judgeOutput: judgeOutput(
      {
        bounded: 5,
        evidence_backed: 5,
        not_setup_as_task: 5,
        useful: 4,
        verifiable: 4,
      },
      "The options are evidence-backed, bounded, and directly verifiable.",
    ),
    name: "good",
  },
  {
    expectedPassed: true,
    input: sanityInput(
      "borderline",
      "Check the checkout session refresh code against the tree note and propose one small verification step.",
    ),
    judgeOutput: judgeOutput(
      {
        bounded: 4,
        evidence_backed: 4,
        not_setup_as_task: 5,
        useful: 3,
        verifiable: 3,
      },
      "Exactly meets every threshold without drifting into setup work.",
    ),
    name: "borderline",
  },
  {
    expectedPassed: false,
    input: sanityInput(
      "bad",
      "First connect GitHub, create a Context Tree, run seed, and then we can think about checkout work.",
    ),
    judgeOutput: judgeOutput(
      {
        bounded: 2,
        evidence_backed: 2,
        not_setup_as_task: 1,
        useful: 2,
        verifiable: 2,
      },
      "This packages setup as the task and is not grounded in the provided evidence.",
    ),
    name: "bad",
  },
];
