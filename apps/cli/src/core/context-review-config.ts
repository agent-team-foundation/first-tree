import {
  type ContextTreeProvider,
  normalizeGitLabWebOrigin,
  orgContextTreeFeaturesOutputSchema,
  orgContextTreeFeaturesStorageSchema,
  orgContextTreeOutputSchema,
  resolveContextTreeProvider,
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
  provider: ContextTreeProvider | null;
  repo: string | null;
  branch: string | null;
  providerMatchesRepository: boolean | null;
  gitlabConnection: { id: string; instanceOrigin: string } | null;
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
  const provider = value.provider;
  const providerMatchesRepository = value.providerMatchesRepository;
  const gitlabConnection = value.gitlabConnection;
  const features = orgContextTreeFeaturesStorageSchema.safeParse({ contextReviewer: value.contextReviewer });
  const parsedGitlabConnection =
    gitlabConnection === null
      ? null
      : typeof gitlabConnection === "object" &&
          gitlabConnection !== null &&
          typeof (gitlabConnection as Record<string, unknown>).id === "string" &&
          (gitlabConnection as Record<string, string>).id.length > 0 &&
          typeof (gitlabConnection as Record<string, unknown>).instanceOrigin === "string" &&
          normalizeGitLabWebOrigin((gitlabConnection as Record<string, string>).instanceOrigin) ===
            (gitlabConnection as Record<string, string>).instanceOrigin
        ? {
            id: (gitlabConnection as Record<string, string>).id,
            instanceOrigin: (gitlabConnection as Record<string, string>).instanceOrigin,
          }
        : undefined;
  if (
    !features.success ||
    (provider !== undefined && provider !== "github" && provider !== "gitlab") ||
    (repo !== null && typeof repo !== "string") ||
    (branch !== null && typeof branch !== "string") ||
    typeof providerMatchesRepository !== "boolean" ||
    parsedGitlabConnection === undefined
  ) {
    throw new SyntaxError("The server returned an invalid Context Review configuration");
  }
  const config = features.data.contextReviewer;
  const resolvedProvider = resolveContextTreeProvider({
    repo: typeof repo === "string" ? repo : null,
    declaredProvider: provider,
  }).provider;
  if (
    (resolvedProvider !== "gitlab" && parsedGitlabConnection !== null) ||
    (resolvedProvider === "gitlab" && providerMatchesRepository && parsedGitlabConnection === null)
  ) {
    throw new SyntaxError("The server returned an invalid Context Review configuration");
  }
  return {
    provider: resolvedProvider,
    repo,
    branch,
    providerMatchesRepository,
    gitlabConnection: parsedGitlabConnection,
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
  const provider = resolveContextTreeProvider({
    repo: binding.data.repo,
    declaredProvider: binding.data.provider,
  }).provider;
  return {
    provider,
    repo: binding.data.repo ?? null,
    branch: binding.data.branch ?? null,
    providerMatchesRepository: provider === "github" ? true : null,
    gitlabConnection: null,
    enabled: reviewer.enabled,
    assigned: reviewer.enabled && reviewer.agentUuid !== null,
    agentUuid: reviewer.agentUuid,
  };
}
