import type { JudgeRubricDimension } from "../../core/judge/types.js";
import type {
  QualityArtifactInput,
  QualityCaseDefinition,
  QualityEvalCase,
  QualitySanityFixture,
} from "../quality/types.js";

const SEED_SKELETON_QUALITY_DIMENSIONS: readonly JudgeRubricDimension[] = [
  {
    description:
      "Skeleton choices are grounded in the supplied source evidence and avoid generic archetypes unsupported by the repo.",
    key: "source_grounding",
    threshold: 4,
  },
  {
    description:
      "Top-level and second-level domains reflect durable concern axes rather than blindly mirroring source directories.",
    key: "structure_fit",
    threshold: 4,
  },
  {
    description:
      "The output proposes the domain skeleton and asks for explicit chat confirmation before any structure or leaf content is written.",
    key: "confirmation_boundary",
    threshold: 5,
  },
  {
    description:
      "The proposal communicates confidence and gaps, such as ON / weak signal / OFF or equivalent uncertainty calibration.",
    key: "coverage_calibration",
    threshold: 3,
  },
  {
    description: "The proposal is reviewable and avoids bloated implementation walkthroughs.",
    key: "conciseness",
    threshold: 3,
  },
];

export const FIRST_TREE_SEED_QUALITY_CASE: QualityEvalCase = {
  briefingMode: "generated-fixture",
  expected: {
    dimensions: SEED_SKELETON_QUALITY_DIMENSIONS.map((dimension) => dimension.key),
    rubric: "first-tree-seed skeleton quality",
  },
  fixture: {
    artifact: "actual domain skeleton proposal produced by empty-tree-source-present",
    gateCaseId: "empty-tree-source-present",
    source: "source evidence from the empty-tree-source-present fixture",
  },
  id: "first-tree-seed-skeleton-quality",
  prompt: "Judge the quality of a first-tree-seed domain skeleton proposal from the empty-tree-source-present gate.",
  provider: "codex",
  skill: "first-tree-seed",
  status: "implemented",
  tags: ["llm-judge", "quality", "skeleton-quality"],
  tier: "quality",
};

function dimensionLines(dimensions: readonly JudgeRubricDimension[]): string {
  return dimensions
    .map((dimension) => `- ${dimension.key}: ${dimension.description} Minimum passing score: ${dimension.threshold}.`)
    .join("\n");
}

function buildSeedJudgePrompt(input: QualityArtifactInput): string {
  return `You are judging a First Tree Context Tree domain skeleton proposed by first-tree-seed.

Return ONLY strict JSON with this shape:
{"scores":{"source_grounding":1,"structure_fit":1,"confirmation_boundary":1,"coverage_calibration":1,"conciseness":1},"reasoning":"one concise paragraph"}

Scores are integers from 1 to 5. Do not include markdown or any extra text.

Rubric:
${dimensionLines(SEED_SKELETON_QUALITY_DIMENSIONS)}

Source material:
\`\`\`text
${input.source}
\`\`\`

Actual domain skeleton proposal from the live gate:
\`\`\`text
${input.artifact}
\`\`\`
`;
}

export const FIRST_TREE_SEED_QUALITY_DEFINITION: QualityCaseDefinition = {
  buildJudgePrompt: buildSeedJudgePrompt,
  dimensions: SEED_SKELETON_QUALITY_DIMENSIONS,
  evalCase: FIRST_TREE_SEED_QUALITY_CASE,
  gateCaseId: "empty-tree-source-present",
  title: "first-tree-seed skeleton quality",
};

function sanityInput(name: QualitySanityFixture["name"], artifact: string): QualityArtifactInput {
  return {
    artifact,
    deterministicGatePassed: true,
    gateCaseId: FIRST_TREE_SEED_QUALITY_DEFINITION.gateCaseId,
    gateRunRoot: `/tmp/${name}-seed-gate`,
    gateSummaryJsonPath: `/tmp/${name}-seed-gate/summary.json`,
    gateSummaryMdPath: `/tmp/${name}-seed-gate/summary.md`,
    source: [
      "README: Apollo Console ships a CLI, web dashboard, and runtime packages for an agent team.",
      "docs/architecture.md: durable concerns are local CLI operations, Cloud onboarding, web operator surfaces, runtime packages, and team practice.",
      "docs/team-practice.md: team handoffs and review gates are durable collaboration conventions.",
    ].join("\n"),
  };
}

function judgeOutput(scores: Record<string, number>, reasoning: string): string {
  return JSON.stringify({ reasoning, scores });
}

export const FIRST_TREE_SEED_QUALITY_SANITY_FIXTURES: readonly QualitySanityFixture[] = [
  {
    expectedPassed: true,
    input: sanityInput(
      "good",
      [
        "Domain skeleton proposal:",
        "- system/",
        "  - cli.md (ON: source names local CLI operations)",
        "  - cloud.md (ON: onboarding and operator dashboard evidence)",
        "  - runtime.md (ON: runtime package signal)",
        "- team-practice/",
        "  - handoffs.md (ON: team practice source)",
        "- members/ (weak signal: owners need confirmation)",
        "Please approve or adjust this skeleton before I write any leaf content.",
      ].join("\n"),
    ),
    judgeOutput: judgeOutput(
      {
        conciseness: 4,
        coverage_calibration: 4,
        confirmation_boundary: 5,
        source_grounding: 5,
        structure_fit: 5,
      },
      "Source-backed concern axes with clear confidence and approval boundary.",
    ),
    name: "good",
  },
  {
    expectedPassed: true,
    input: sanityInput(
      "borderline",
      [
        "Propose system/, product/, and team-practice/ with CLI/web/runtime second-level nodes.",
        "Signals are strongest for CLI and web; runtime and members are weak and need confirmation.",
        "Reply approve or edit before I create leaf nodes.",
      ].join("\n"),
    ),
    judgeOutput: judgeOutput(
      {
        conciseness: 3,
        coverage_calibration: 3,
        confirmation_boundary: 5,
        source_grounding: 4,
        structure_fit: 4,
      },
      "Minimal but source grounded and exactly meets the thresholds.",
    ),
    name: "borderline",
  },
  {
    expectedPassed: false,
    input: sanityInput(
      "bad",
      [
        "Create a generic SaaS tree with frontend/, backend/, database/, billing/, and analytics/.",
        "## Decision",
        "The backend uses PostgreSQL and Redis.",
        "I will now write the leaves and open a PR without waiting for approval.",
      ].join("\n"),
    ),
    judgeOutput: judgeOutput(
      {
        conciseness: 2,
        coverage_calibration: 1,
        confirmation_boundary: 1,
        source_grounding: 2,
        structure_fit: 2,
      },
      "Generic template, premature leaf content, and no confirmation boundary.",
    ),
    name: "bad",
  },
];
