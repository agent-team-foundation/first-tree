export type JudgeProviderName = "codex" | "fake";

export type JudgeRubricDimension = {
  description: string;
  key: string;
  threshold: number;
};

export type JudgeRequest = {
  caseId: string;
  dimensions: readonly JudgeRubricDimension[];
  prompt: string;
};

export type JudgeProviderResponse = {
  cost_usd: number | null;
  duration_ms: number;
  judge_model: string;
  provider: JudgeProviderName;
  raw_output: string;
};

export type ParsedJudgeOutput = {
  judge_reasoning: string;
  judge_scores: Record<string, number>;
};

export type JudgeEvaluation = ParsedJudgeOutput & {
  failures: readonly string[];
  passed: boolean;
  thresholds: Record<string, number>;
};

export type JudgeProvider = {
  judge(request: JudgeRequest): Promise<JudgeProviderResponse>;
};
