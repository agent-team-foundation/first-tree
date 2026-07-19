import {
  orgContextTreeFeaturesOutputSchema,
  orgContextTreeFeaturesStorageSchema,
  orgContextTreeOutputSchema,
} from "@first-tree/shared";

export type ContextReviewConfigReader = {
  readonly agentId?: string;
  getAgentContextReviewConfig(): Promise<unknown>;
};

export type MemberContextReviewConfigReader = {
  getMemberContextTreeSetting(organizationId: string): Promise<unknown>;
  getMemberContextTreeFeatures(organizationId: string): Promise<unknown>;
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

/** Read the same configuration through member-readable generic settings. */
export async function readMemberContextReviewConfig(
  sdk: MemberContextReviewConfigReader,
  organizationId: string,
): Promise<ContextReviewConfigResult> {
  const [rawBinding, rawFeatures] = await Promise.all([
    sdk.getMemberContextTreeSetting(organizationId),
    sdk.getMemberContextTreeFeatures(organizationId),
  ]);
  const binding = orgContextTreeOutputSchema.safeParse(rawBinding);
  const features = orgContextTreeFeaturesOutputSchema.safeParse(rawFeatures);
  if (!binding.success || !features.success) {
    throw new SyntaxError("The server returned an invalid Context Review configuration");
  }
  const reviewer = features.data.contextReviewer;
  return {
    repo: binding.data.repo ?? null,
    branch: binding.data.branch ?? null,
    enabled: reviewer.enabled,
    assigned: reviewer.enabled && reviewer.agentUuid !== null,
    agentUuid: reviewer.agentUuid,
  };
}
