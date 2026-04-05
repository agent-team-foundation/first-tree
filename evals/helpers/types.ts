/**
 * Core types for the first-tree eval harness.
 */

/** A single repo to clone into the sandbox. */
export interface RepoRef {
  repo: string;
  commit_sha: string;
  path?: string;     // subdirectory name in sandbox (defaults to repo name)
  setup?: string;    // per-repo setup commands (run in repo's directory)
}

/** Test case loaded from YAML — the problem to solve. */
export interface EvalCase {
  id: string;
  source: 'custom' | 'swebench';
  repos: RepoRef[];  // one or more repos
  task: string;
  golden_pr?: string;
  fix_commit_sha?: string;  // merge commit of the fix PR (for env validation)
  verification: string;
  difficulty: 'easy' | 'medium' | 'hard';
  timeout_ms?: number;
  max_turns?: number;
  context_tree_versions?: TreeVersionRef[];
}

/**
 * Condition — what tools/context the agent gets.
 * Baseline has no tree. Tree conditions reference a commit in the context tree repo.
 */
export interface EvalCondition {
  label: string;
  tree_sha?: string;
}

/** A pinned context tree version embedded in a case YAML. */
export interface TreeVersionRef {
  label: string;      // e.g. "cli-v0.0.3"
  tree_sha: string;   // commit SHA in the context tree repo
}

/** Global config for how to find context trees. */
export interface ContextTreeConfig {
  repo: string;       // e.g. "agent-team-foundation/eval-context-trees"
}

export interface AgentConfig {
  cli: 'claude-code' | 'codex' | 'gemini';
  model: string;
}

export interface ModelTokens {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUSD: number;
}

export interface CostEstimate {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  estimatedCost: number;
  turnsUsed: number;
  /** Per-model breakdown (main agent + subagents). */
  modelBreakdown?: ModelTokens[];
}

export interface SessionResult {
  toolCalls: Array<{ tool: string; input: any; output: string }>;
  exitReason: string;
  duration: number;
  output: string;
  costEstimate: CostEstimate;
  transcript: any[];
  model: string;
  firstResponseMs: number;
  maxInterTurnMs: number;
}

export interface TrialResult {
  case_id: string;
  condition: string;
  trial: number;

  // Correctness
  passed: boolean;
  tests_total: number;
  tests_passed: number;

  // Efficiency
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  api_calls: number;
  wall_clock_ms: number;
  cost_usd: number;

  // Diagnostics
  exit_reason: string;
  transcript: any[];
  model: string;
  cli: string;
  error?: string;
  model_breakdown?: ModelTokens[];
}

export interface EvalRun {
  schema_version: number;
  timestamp: string;
  git_sha: string;
  branch: string;
  hostname: string;
  model: string;
  cli: string;
  conditions: string[];
  trials: TrialResult[];
  total_cost_usd: number;
  total_duration_ms: number;
  wall_clock_ms: number;
}
