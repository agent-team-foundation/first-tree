import type { SetupBlocker, TeamSetupCapabilities } from "@first-tree/shared";

function hasAdminOwnedBlocker(blockers: SetupBlocker[]): boolean {
  return blockers.some((blocker) => blocker.resolutionOwner === "admin");
}

/**
 * Decide whether Team Setup needs an action from the current admin.
 *
 * The Server projection is the sole source of Team readiness here. Optional
 * capabilities stay neutral until adopted: an available provider, an unbound
 * Context Tree, and unavailable/disabled Automatic Review must not light up
 * the Settings navigation merely because they are not configured.
 */
export function teamSetupNeedsAttention(
  capabilities: TeamSetupCapabilities | null | undefined,
  role: string | null,
): boolean {
  if (role !== "admin" || !capabilities) return false;

  const repositoryAutomationNeedsAttention = capabilities.repositoryAutomation.providers.some(
    (provider) => provider.adoption !== "available" && hasAdminOwnedBlocker(provider.blockers),
  );
  const contextTreeNeedsAttention =
    capabilities.contextTree.binding.state !== "unbound" && hasAdminOwnedBlocker(capabilities.contextTree.blockers);
  const automaticReviewNeedsAttention =
    capabilities.contextTree.automaticReview.adoption === "enabled" &&
    hasAdminOwnedBlocker(capabilities.contextTree.automaticReview.blockers);

  return repositoryAutomationNeedsAttention || contextTreeNeedsAttention || automaticReviewNeedsAttention;
}

export function personalSetupNeedsAttention({
  currentOrgHasUsableAgent,
  onboardingDismissedAt,
  onboardingCompletedAt,
}: {
  currentOrgHasUsableAgent: boolean;
  onboardingDismissedAt: string | null;
  onboardingCompletedAt: string | null;
}): boolean {
  return currentOrgHasUsableAgent === false || (onboardingDismissedAt !== null && onboardingCompletedAt === null);
}
