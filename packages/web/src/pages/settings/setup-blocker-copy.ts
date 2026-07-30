import type { SetupBlockerCode } from "@first-tree/shared";

const SETUP_BLOCKER_COPY = {
  provider_probe_failed: "First Tree could not verify provider readiness.",
  github_app_not_configured: "GitHub automation is not configured for this First Tree deployment.",
  github_app_suspended: "The GitHub App installation is suspended.",
  github_webhook_events_missing: "Required GitHub App webhook events are missing.",
  github_pull_requests_permission_required: "GitHub pull-request write access is required.",
  github_tree_repo_not_covered: "The GitHub App cannot access this Context Tree repository.",
  github_app_slug_missing:
    "A deployment operator must configure the GitHub App login before App-target delegation can run.",
  github_app_task_reply_permission_required:
    "The GitHub App installation must grant Issues and Pull requests write access for App-authored task replies.",
  gitlab_webhook_not_seen: "Waiting for the first valid GitLab webhook.",
  gitlab_hook_source_not_identified:
    "Webhook traffic was received before source-specific health was available. Trigger an enabled event from the configured Hook.",
  gitlab_merge_request_event_not_seen: "Waiting for a valid Merge Request event from the System Hook.",
  gitlab_processing_failed: "Recent GitLab webhook processing failed.",
  context_tree_binding_invalid: "The Context Tree binding is invalid.",
  context_tree_provider_unresolved: "The Context Tree provider could not be resolved.",
  context_tree_connection_mismatch: "The Context Tree repository does not match the current GitLab connection.",
  context_review_provider_prerequisite_missing: "The repository provider must be connected before review can run.",
  context_review_assignment_required: "Choose a reviewer before enabling Automatic Review.",
  context_review_no_eligible_agent: "No eligible organization-visible managed Agent is available.",
  context_review_agent_missing: "The configured reviewer is missing.",
  context_review_agent_inactive: "The configured reviewer is inactive.",
  context_review_agent_manager_inactive: "The configured reviewer's manager is inactive.",
  context_review_agent_private: "The configured reviewer is private and cannot run Automatic Review.",
  context_review_agent_no_runtime:
    "The configured reviewer needs a supported runtime on a usable Computer owned by its manager.",
  context_review_agent_runtime_unavailable: "The configured reviewer's runtime is currently unavailable.",
  context_review_state_changed: "Reviewer settings changed while this request was in progress.",
  team_agent_conflicts_context_reviewer: "The GitHub Task Agent and Context Reviewer must be different Agents.",
} satisfies Record<SetupBlockerCode, string>;

export function setupBlockerCopy(code: SetupBlockerCode): string {
  return SETUP_BLOCKER_COPY[code];
}
