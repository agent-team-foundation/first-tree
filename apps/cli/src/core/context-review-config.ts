import { orgContextTreeFeaturesStorageSchema } from "@first-tree/shared";

export type ContextReviewConfigReader = {
  readonly agentId?: string;
  getAgentContextReviewConfig(): Promise<unknown>;
};

export type ContextReviewConfigResult = {
  repo: string | null;
  branch: string | null;
  enabled: boolean;
  assigned: boolean;
  agentUuid: string | null;
};

export function normalizeContextReviewConfig(
  response: unknown,
  agentId: string | undefined,
): ContextReviewConfigResult {
  if (typeof response !== "object" || response === null) {
    throw new SyntaxError("The server returned an invalid Context Review configuration");
  }
  const value = response as Record<string, unknown>;
  const repo = value.repo;
  const branch = value.branch;
  const features = orgContextTreeFeaturesStorageSchema.safeParse({ contextReviewer: value.contextReviewer });
  if (
    !features.success ||
    (repo !== null && typeof repo !== "string") ||
    (branch !== null && typeof branch !== "string")
  ) {
    throw new SyntaxError("The server returned an invalid Context Review configuration");
  }
  const config = features.data.contextReviewer;
  return {
    repo,
    branch,
    enabled: config.enabled,
    assigned: config.enabled && agentId !== undefined && config.agentUuid === agentId,
    agentUuid: config.agentUuid,
  };
}

export async function readContextReviewConfig(sdk: ContextReviewConfigReader): Promise<ContextReviewConfigResult> {
  return normalizeContextReviewConfig(await sdk.getAgentContextReviewConfig(), sdk.agentId);
}
