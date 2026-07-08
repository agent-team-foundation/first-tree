import type { ShippedSkillName, SkillEvalCase } from "../../core/case-schema.js";
import type { JudgeRubricDimension } from "../../core/judge/types.js";
import type { AgentProviderName } from "../../core/provider/types.js";
import type { QualityJudgeRunResult } from "../../core/result-schema.js";

export type QualitySkillName = Extract<ShippedSkillName, "first-tree-write" | "first-tree-seed" | "first-tree-welcome">;

export type QualityFixture = {
  artifact: string;
  gateCaseId: string;
  source: string;
};

export type QualityArtifactInput = {
  artifact: string;
  deterministicGatePassed: boolean;
  gateCaseId: string;
  gateRunRoot: string | null;
  gateSummaryJsonPath: string | null;
  gateSummaryMdPath: string | null;
  source: string;
};

export type QualityExpected = {
  dimensions: readonly string[];
  rubric: string;
};

export type QualitySanityFixture = {
  expectedPassed: boolean;
  input: QualityArtifactInput;
  judgeOutput: string;
  name: "bad" | "borderline" | "good";
};

export type QualityEvalCase = SkillEvalCase<QualityFixture, QualityExpected> & {
  provider: "codex";
  skill: QualitySkillName;
  status: "implemented";
  tier: "quality";
};

export type QualityCaseDefinition = {
  buildJudgePrompt: (input: QualityArtifactInput) => string;
  dimensions: readonly JudgeRubricDimension[];
  evalCase: QualityEvalCase;
  gateCaseId: string;
  title: string;
};

export type QualityRunOptions = {
  caseId: string | null;
  claudeBin: string;
  codexBin: string;
  judgeBin: string;
  judgeModel: string | null;
  json: boolean;
  model: string | null;
  provider: AgentProviderName;
  suite: QualitySkillName | null;
  verbose: boolean;
};

export type QualityCaseRunSummary = QualityJudgeRunResult & {
  artifact: string;
  deterministicGatePassed: boolean;
  dimensions: readonly JudgeRubricDimension[];
  gateCaseId: string;
  gateRunRoot: string | null;
  gateSummaryJsonPath: string | null;
  gateSummaryMdPath: string | null;
  judgePrompt: string;
  judgePromptPath: string;
  judgeRawOutputPath: string;
  runRoot: string;
  source: string;
  startedAt: string;
  summaryJsonPath: string;
  summaryMdPath: string;
};

export type QualityBatchSummary = {
  cases: readonly QualityCaseRunSummary[];
  failed: number;
  passed: number;
  runStartedAt: string;
};
