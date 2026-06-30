import type { JudgeRubricDimension } from "../../core/judge/types.js";
import type {
  QualityArtifactInput,
  QualityCaseDefinition,
  QualityEvalCase,
  QualitySanityFixture,
} from "../quality/types.js";

const WRITE_NODE_QUALITY_DIMENSIONS: readonly JudgeRubricDimension[] = [
  {
    description:
      "The node captures durable context, decisions, and rationale instead of transient PR process or implementation minutiae.",
    key: "durability",
    threshold: 4,
  },
  {
    description:
      "The node stays bounded to the supplied source material and avoids unsupported claims, PR IDs, code signatures, or API shapes.",
    key: "source_boundary",
    threshold: 4,
  },
  {
    description: "The node explains why the decision exists well enough for a future agent to use it.",
    key: "rationale_quality",
    threshold: 3,
  },
  {
    description: "The node is concise and avoids bloated historical narration while preserving the necessary context.",
    key: "conciseness",
    threshold: 3,
  },
];

export const FIRST_TREE_WRITE_QUALITY_CASE: QualityEvalCase = {
  briefingMode: "minimal",
  expected: {
    dimensions: WRITE_NODE_QUALITY_DIMENSIONS.map((dimension) => dimension.key),
    rubric: "first-tree-write node quality",
  },
  fixture: {
    artifact: "actual tree diff produced by durable-source-writes",
    gateCaseId: "durable-source-writes",
    source: "source-artifacts/durable-decision-note.md from the durable-source-writes fixture",
  },
  id: "first-tree-write-node-quality",
  prompt: "Judge the quality of a first-tree-write Context Tree node produced from a durable source note.",
  provider: "codex",
  skill: "first-tree-write",
  status: "implemented",
  tags: ["llm-judge", "quality", "node-quality"],
  tier: "quality",
};

function dimensionLines(dimensions: readonly JudgeRubricDimension[]): string {
  return dimensions
    .map((dimension) => `- ${dimension.key}: ${dimension.description} Minimum passing score: ${dimension.threshold}.`)
    .join("\n");
}

function buildWriteJudgePrompt(input: QualityArtifactInput): string {
  return `You are judging a First Tree Context Tree node written by first-tree-write.

Return ONLY strict JSON with this shape:
{"scores":{"durability":1,"source_boundary":1,"rationale_quality":1,"conciseness":1},"reasoning":"one concise paragraph"}

Scores are integers from 1 to 5. Do not include markdown or any extra text.

Rubric:
${dimensionLines(WRITE_NODE_QUALITY_DIMENSIONS)}

Source material:
\`\`\`text
${input.source}
\`\`\`

Actual Context Tree diff produced by the live gate:
\`\`\`text
${input.artifact}
\`\`\`
`;
}

export const FIRST_TREE_WRITE_QUALITY_DEFINITION: QualityCaseDefinition = {
  buildJudgePrompt: buildWriteJudgePrompt,
  dimensions: WRITE_NODE_QUALITY_DIMENSIONS,
  evalCase: FIRST_TREE_WRITE_QUALITY_CASE,
  gateCaseId: "durable-source-writes",
  title: "first-tree-write node quality",
};

function sanityInput(name: QualitySanityFixture["name"], artifact: string): QualityArtifactInput {
  return {
    artifact,
    deterministicGatePassed: true,
    gateCaseId: FIRST_TREE_WRITE_QUALITY_DEFINITION.gateCaseId,
    gateRunRoot: `/tmp/${name}-write-gate`,
    gateSummaryJsonPath: `/tmp/${name}-write-gate/summary.json`,
    gateSummaryMdPath: `/tmp/${name}-write-gate/summary.md`,
    source: [
      "Decision: keep Context Tree nodes focused on durable product and architecture context.",
      "Rationale: future agents need the stable rule, not every transient PR step.",
    ].join("\n"),
  };
}

function judgeOutput(scores: Record<string, number>, reasoning: string): string {
  return JSON.stringify({ reasoning, scores });
}

export const FIRST_TREE_WRITE_QUALITY_SANITY_FIXTURES: readonly QualitySanityFixture[] = [
  {
    expectedPassed: true,
    input: sanityInput(
      "good",
      [
        "+--- a/system/context-management/task-skill-design.md",
        "++ Agents write durable Context Tree updates only from explicit source artifacts.",
        "++ This keeps the tree grounded in decisions and rationale that future agents can reuse.",
      ].join("\n"),
    ),
    judgeOutput: judgeOutput(
      {
        conciseness: 4,
        durability: 5,
        rationale_quality: 4,
        source_boundary: 5,
      },
      "Durable, source-bounded, and concise.",
    ),
    name: "good",
  },
  {
    expectedPassed: true,
    input: sanityInput(
      "borderline",
      [
        "+--- a/system/context-management/task-skill-design.md",
        "++ Context Tree updates require an explicit source artifact and should preserve the durable reason.",
      ].join("\n"),
    ),
    judgeOutput: judgeOutput(
      {
        conciseness: 3,
        durability: 4,
        rationale_quality: 3,
        source_boundary: 4,
      },
      "Exactly meets every threshold.",
    ),
    name: "borderline",
  },
  {
    expectedPassed: false,
    input: sanityInput(
      "bad",
      [
        "+--- a/system/context-management/task-skill-design.md",
        "++ PR #123 changed a helper signature in packages/foo/src/bar.ts and the reviewer approved it.",
      ].join("\n"),
    ),
    judgeOutput: judgeOutput(
      {
        conciseness: 3,
        durability: 2,
        rationale_quality: 2,
        source_boundary: 3,
      },
      "Implementation minutiae and unsupported PR details fall below the rubric.",
    ),
    name: "bad",
  },
];
