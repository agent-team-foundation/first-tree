import { runClaudeProvider } from "./claude.js";
import { runCodexProvider } from "./codex.js";
import type { AgentProviderName, ProviderRunContext, ProviderRunOptions, ProviderRunResult } from "./types.js";

export type AgentProviderCliOptions = {
  claudeBin: string;
  codexBin: string;
  provider: AgentProviderName;
};

export function providerBin(options: AgentProviderCliOptions): string {
  return options.provider === "claude" ? options.claudeBin : options.codexBin;
}

export async function runAgentProvider(
  options: Omit<ProviderRunOptions, "bin"> & AgentProviderCliOptions,
  context: ProviderRunContext,
): Promise<ProviderRunResult> {
  const bin = providerBin(options);
  const runOptions: ProviderRunOptions = {
    bin,
    caseId: options.caseId,
    model: options.model,
    prompt: options.prompt,
    provider: options.provider,
    verbose: options.verbose,
  };
  const exitCode =
    options.provider === "claude"
      ? await runClaudeProvider(runOptions, context)
      : await runCodexProvider(runOptions, context);
  return {
    exitCode,
    model: options.model,
    provider: options.provider,
  };
}

export type { AgentProviderName, ProviderRunContext, ProviderRunOptions, ProviderRunResult };
