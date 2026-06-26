import type { EvalReporter } from "../reporter.js";
import type { RunPaths } from "../types.js";

export type ProviderRunOptions = {
  bin: string;
  caseId: string;
  model: string | null;
  prompt: string;
  verbose: boolean;
};

export type ProviderRunContext = {
  paths: RunPaths;
  reporter: EvalReporter;
};
