export type SkillCaseScoreKey = "routing_pass" | "process_pass" | "outcome_pass" | "risk_pass";

export type SkillCaseScores = Record<SkillCaseScoreKey, boolean>;

export type GradingEvidence = {
  detail: string;
  label: string;
};

export type RiskFlag = {
  detail: string;
  label: string;
};

export type SkillCaseGrading = {
  caseId: string;
  evidence: readonly GradingEvidence[];
  passed: boolean;
  riskFlags: readonly RiskFlag[];
  scores: SkillCaseScores;
};

export type SkillEvalRunResult = {
  caseId: string;
  durationMs?: number;
  grading: SkillCaseGrading;
  runId: string;
  skill: string;
  tier: string;
};

export type QualityJudgeRunResult = {
  caseId: string;
  cost_usd: number | null;
  duration_ms: number;
  failures: readonly string[];
  judge_model: string;
  judge_provider: string;
  judge_reasoning: string | null;
  judge_scores: Record<string, number> | null;
  passed: boolean;
  raw_output: string;
  runId: string;
  skill: string;
  thresholds: Record<string, number>;
  tier: "quality";
};

export function allScoresPass(scores: SkillCaseScores): boolean {
  return scores.routing_pass && scores.process_pass && scores.outcome_pass && scores.risk_pass;
}
