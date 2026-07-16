import { orgContextTreeFeaturesOutputSchema } from "@first-tree/shared";

export type ContextReviewConfigReader = {
  readonly agentId?: string;
  getAgentContextReviewConfig(): Promise<unknown>;
};

export type ContextReviewConfigResult = {
  enabled: boolean;
  assigned: boolean;
  agentUuid: string | null;
  workflow: "legacy_app" | "agent_review";
  governance: "human" | "autonomous";
  mergeMethod: "merge" | "squash" | "rebase";
};

export function normalizeContextReviewConfig(
  response: unknown,
  agentId: string | undefined,
): ContextReviewConfigResult {
  const parsed = orgContextTreeFeaturesOutputSchema.safeParse({ contextReviewer: response });
  if (!parsed.success) {
    throw new SyntaxError("The server returned an invalid Context Review configuration");
  }
  const config = parsed.data.contextReviewer;
  return {
    enabled: config.enabled,
    assigned: config.enabled && agentId !== undefined && config.agentUuid === agentId,
    agentUuid: config.agentUuid,
    workflow: config.workflow,
    governance: config.governance,
    mergeMethod: config.mergeMethod,
  };
}

export async function readContextReviewConfig(sdk: ContextReviewConfigReader): Promise<ContextReviewConfigResult> {
  return normalizeContextReviewConfig(await sdk.getAgentContextReviewConfig(), sdk.agentId);
}
