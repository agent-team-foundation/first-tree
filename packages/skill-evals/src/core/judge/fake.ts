import type { JudgeProvider, JudgeProviderResponse, JudgeRequest } from "./types.js";

export function createFakeJudgeProvider(rawOutputs: ReadonlyMap<string, string>): JudgeProvider {
  return {
    async judge(request: JudgeRequest): Promise<JudgeProviderResponse> {
      const rawOutput = rawOutputs.get(request.caseId);
      if (rawOutput === undefined) {
        throw new Error(`No fake judge output configured for ${request.caseId}.`);
      }

      return {
        cost_usd: null,
        duration_ms: 0,
        judge_model: "fake-judge",
        provider: "fake",
        raw_output: rawOutput,
      };
    },
  };
}
