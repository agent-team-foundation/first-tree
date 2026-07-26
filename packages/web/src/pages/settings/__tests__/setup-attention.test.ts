import type { SetupBlocker, TeamSetupCapabilities } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import {
  contextTreeSnapshotNeedsAttention,
  personalSetupNeedsAttention,
  teamSetupNeedsAttention,
} from "../setup-attention.js";

const OBSERVED_AT = "2026-07-23T08:00:00.000Z";
const ADMIN_BLOCKER: SetupBlocker = {
  code: "github_app_suspended",
  resolutionOwner: "admin",
  actionKind: "manage_github_installation",
};
const OPERATOR_BLOCKER: SetupBlocker = {
  code: "provider_probe_failed",
  resolutionOwner: "operator",
  actionKind: null,
};

function capabilities(): TeamSetupCapabilities {
  return {
    organizationId: "org-1",
    repositoryAutomation: {
      providers: [
        {
          provider: "github",
          adoption: "enabled",
          health: "ready",
          blockers: [],
          observedAt: OBSERVED_AT,
        },
        {
          provider: "gitlab",
          adoption: "available",
          health: "not_observed",
          blockers: [],
          observedAt: OBSERVED_AT,
        },
      ],
    },
    contextTree: {
      binding: {
        state: "bound",
        provider: "github",
        repo: "https://github.com/acme/context-tree.git",
        branch: "main",
      },
      blockers: [],
      automaticReview: {
        adoption: "disabled",
        health: "not_observed",
        reviewerAgent: null,
        blockers: [],
        observedAt: OBSERVED_AT,
      },
    },
  };
}

describe("Setup navigation attention", () => {
  it("shows Team attention only to admins for explicit admin-owned blockers", () => {
    const value = capabilities();
    const github = value.repositoryAutomation.providers[0];
    if (!github) throw new Error("Expected GitHub capability");
    github.health = "degraded";
    github.blockers = [ADMIN_BLOCKER];

    expect(teamSetupNeedsAttention(value, "admin")).toBe(true);
    expect(teamSetupNeedsAttention(value, "member")).toBe(false);

    github.blockers = [OPERATOR_BLOCKER];
    expect(teamSetupNeedsAttention(value, "admin")).toBe(false);
    expect(teamSetupNeedsAttention(null, "admin")).toBe(false);
  });

  it("keeps optional unconfigured capabilities neutral even when their projection explains prerequisites", () => {
    const value = capabilities();
    const gitlab = value.repositoryAutomation.providers[1];
    if (!gitlab) throw new Error("Expected GitLab capability");
    gitlab.blockers = [
      {
        code: "gitlab_webhook_not_seen",
        resolutionOwner: "admin",
        actionKind: "configure_gitlab_webhook",
      },
    ];
    value.contextTree.binding = { state: "unbound" };
    value.contextTree.blockers = [
      {
        code: "context_tree_binding_invalid",
        resolutionOwner: "admin",
        actionKind: "repair_tree_binding",
      },
    ];
    value.contextTree.automaticReview.blockers = [
      {
        code: "context_review_agent_missing",
        resolutionOwner: "admin",
        actionKind: "select_review_agent",
      },
    ];

    expect(teamSetupNeedsAttention(value, "admin")).toBe(false);
  });

  it("recognizes adopted Tree and Automatic Review blockers without inferring health locally", () => {
    const tree = capabilities();
    tree.contextTree.blockers = [
      {
        code: "context_tree_connection_mismatch",
        resolutionOwner: "admin",
        actionKind: "repair_tree_binding",
      },
    ];
    expect(teamSetupNeedsAttention(tree, "admin")).toBe(true);

    const review = capabilities();
    review.contextTree.automaticReview.adoption = "enabled";
    review.contextTree.automaticReview.health = "degraded";
    review.contextTree.automaticReview.blockers = [
      {
        code: "context_review_agent_inactive",
        resolutionOwner: "admin",
        actionKind: "replace_review_agent",
      },
    ];
    expect(teamSetupNeedsAttention(review, "admin")).toBe(true);
  });

  it("uses the owner snapshot only for admin-recoverable unavailable Tree attention", () => {
    expect(contextTreeSnapshotNeedsAttention("unavailable", "admin")).toBe(true);
    expect(contextTreeSnapshotNeedsAttention("unavailable", "member")).toBe(false);
    expect(contextTreeSnapshotNeedsAttention("stale", "admin")).toBe(false);
    expect(contextTreeSnapshotNeedsAttention("active", "admin")).toBe(false);
    expect(contextTreeSnapshotNeedsAttention(undefined, "admin")).toBe(false);
  });

  it("keeps personal access attention independent of Team role", () => {
    expect(
      personalSetupNeedsAttention({
        currentOrgHasUsableAgent: false,
        onboardingDismissedAt: null,
        onboardingCompletedAt: null,
      }),
    ).toBe(true);
    expect(
      personalSetupNeedsAttention({
        currentOrgHasUsableAgent: true,
        onboardingDismissedAt: OBSERVED_AT,
        onboardingCompletedAt: null,
      }),
    ).toBe(true);
    expect(
      personalSetupNeedsAttention({
        currentOrgHasUsableAgent: true,
        onboardingDismissedAt: null,
        onboardingCompletedAt: OBSERVED_AT,
      }),
    ).toBe(false);
  });
});
