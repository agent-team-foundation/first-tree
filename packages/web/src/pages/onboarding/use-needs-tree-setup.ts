import { useQuery } from "@tanstack/react-query";
import { getContextTreeSetting } from "../../api/org-settings.js";
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
 * Detect the "finished setup but never built a tree" state — the residue of the
 * skip-the-code-step onboarding path (see {@link needsTreeSetup}).
 *
 * Reuses the same `["org-setting", orgId, "context_tree"]` query key as the
 * Context-tree settings panel, so the binding is fetched once and shared. Only
 * fires for an admin past onboarding; members and in-progress users skip the
 * request entirely.
 */
export function useNeedsTreeSetup(): NeedsTreeSetup {
  const { meLoaded, role, organizationId, onboardingCompletedAt } = useAuth();
  const eligible = meLoaded && role === "admin" && onboardingCompletedAt !== null && !!organizationId;

  const treeQuery = useQuery({
    queryKey: ["org-setting", organizationId, "context_tree"],
    queryFn: () => getContextTreeSetting(organizationId ?? ""),
    enabled: eligible,
    retry: false,
  });

  // Only evaluate on a successful probe: a loading/errored binding lookup must
  // not be read as "no tree" (that would offer recovery on a transient blip).
  const result =
    eligible && treeQuery.isSuccess
      ? needsTreeSetup({ meLoaded, onboardingCompletedAt, role, hasTreeBinding: !!treeQuery.data.repo })
      : false;

  return {
    needsTreeSetup: result,
    isLoading: eligible && treeQuery.isLoading,
    isError: eligible && treeQuery.isError,
    refetch: () => {
      void treeQuery.refetch();
    },
  };
}
