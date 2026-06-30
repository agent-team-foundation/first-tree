import type { EvalReporter } from "../reporter.js";
import type { RunPaths } from "../types.js";

export type AgentProviderName = "codex" | "claude";

export type ProviderRunOptions = {
  bin: string;
  caseId: string;
  model: string | null;
  prompt: string;
  provider: AgentProviderName;
  verbose: boolean;
};

export type ProviderRunContext = {
  paths: RunPaths;
  reporter: EvalReporter;
};

export type ProviderRunResult = {
  exitCode: number;
  model: string | null;
  provider: AgentProviderName;
};
