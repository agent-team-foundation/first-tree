import { useQuery } from "@tanstack/react-query";
import { getTreeSetupStatus } from "../../api/onboarding-events.js";
import { useAuth } from "../../auth/auth-context.js";
import { needsTreeSetup } from "./steps.js";

export type NeedsTreeSetup = {
  /**
   * True only once we have a definitive answer that this admin finished
   * onboarding without ever provisioning a Context Tree. Stays `false` while
   * loading and on a failed probe — a "build your tree" card must never flash
   * from a transient miss or nag a user we couldn't confirm.
   */
  needsTreeSetup: boolean;
  /** True while the binding probe is in flight (consumers can hold rendering). */
  isLoading: boolean;
  /**
   * True when the binding probe errored — the answer is INDETERMINATE. Callers
   * must not read `needsTreeSetup === false` as "no recovery needed" here (e.g.
   * `/build-tree` must not redirect out on a transient network blip); show a
   * retry instead.
   */
  isError: boolean;
  /** Re-run the binding probe (e.g. a "Try again" after `isError`). */
  refetch: () => void;
};

/**
 * Detect the "finished setup but never queued tree setup" state — either the
 * skip-the-code-step path (no binding) or a recoverable background failure where
 * Cloud wrote the binding but the tree kickoff bootstrap never reached a chat.
 *
 * Only fires for an admin past onboarding; members and in-progress users skip
 * the request entirely.
 */
export function useNeedsTreeSetup(): NeedsTreeSetup {
  const { meLoaded, role, organizationId, onboardingCompletedAt } = useAuth();
  const eligible = meLoaded && role === "admin" && onboardingCompletedAt !== null && !!organizationId;

  const statusQuery = useQuery({
    queryKey: ["me", "onboarding", "tree-setup-status", organizationId],
    queryFn: () => getTreeSetupStatus(organizationId ?? ""),
    enabled: eligible,
    retry: false,
  });

  // Only evaluate on a successful probe: a loading/errored setup lookup must not
  // be read as "needs setup" (that would offer recovery on a transient blip).
  const result =
    eligible && statusQuery.isSuccess
      ? needsTreeSetup({
          meLoaded,
          onboardingCompletedAt,
          role,
          treeSetupNeedsAttention: statusQuery.data.needsTreeSetup,
        })
      : false;

  return {
    needsTreeSetup: result,
    isLoading: eligible && statusQuery.isLoading,
    isError: eligible && statusQuery.isError,
    refetch: () => {
      void statusQuery.refetch();
    },
  };
}
