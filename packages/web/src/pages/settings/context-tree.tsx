import type { SetupAutomaticReview, SetupContextTreeBinding } from "@first-tree/shared";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { useEffect, useRef } from "react";
import { Link, useLocation } from "react-router";
import { getContextTreeSnapshot } from "../../api/context-tree.js";
import { getTeamSetupCapabilitiesAt, setupCapabilitiesQueryKey } from "../../api/setup-capabilities.js";
import { useAuth } from "../../auth/auth-context.js";
import { Button } from "../../components/ui/button.js";
import { Section } from "../../components/ui/section.js";
import { isTeamNonActionableGitlabWebContext } from "../context-tree-availability.js";
import { ContextPersonalAccess } from "./context-enablement.js";
import { SetupContextTreeControls } from "./setup-context-tree-controls.js";
import { SetupReviewerControls } from "./setup-reviewer-controls.js";

const BINDING_HASH = "#binding";
const AUTOMATIC_REVIEW_HASH = "#automatic-review";
const CODING_AGENT_ACCESS_HASH = "#coding-agent-access";

type ContextTreeAvailability = "active" | "stale" | "unavailable" | "checking" | "unknown" | null;

/**
 * Canonical Context Tree configuration surface.
 *
 * The top-level `/context` page stays read-only and explains freshness and
 * usage. This page owns the selected Team's binding, automatic-review
 * assignment, and personal coding-agent handoff. Members see the same Team
 * facts without receiving admin mutation controls.
 */
export function SettingsContextTreePage({
  preparePrompt,
}: {
  preparePrompt?: (organizationId: string) => Promise<string>;
} = {}) {
  const { organizationId, role } = useAuth();
  const location = useLocation();
  const bindingRef = useRef<HTMLElement>(null);
  const automaticReviewRef = useRef<HTMLElement>(null);
  const codingAgentAccessRef = useRef<HTMLElement>(null);
  const isAdmin = role === "admin";

  const capabilitiesQuery = useQuery({
    queryKey: setupCapabilitiesQueryKey(organizationId),
    queryFn: () =>
      organizationId ? getTeamSetupCapabilitiesAt(organizationId) : Promise.reject(new Error("no organization")),
    enabled: !!organizationId,
  });
  const binding = capabilitiesQuery.data?.contextTree.binding;
  const contextBound = binding?.state === "bound";
  const snapshotQuery = useQuery({
    queryKey: ["context-tree-snapshot", organizationId, "7d", false],
    queryFn: () =>
      organizationId ? getContextTreeSnapshot(organizationId, "7d") : Promise.reject(new Error("no organization")),
    enabled: !!organizationId && contextBound,
  });
  const availability: ContextTreeAvailability = !contextBound
    ? null
    : snapshotQuery.isPending
      ? "checking"
      : snapshotQuery.isError || !snapshotQuery.data
        ? "unknown"
        : snapshotQuery.data.snapshotStatus;
  const teamNonActionableGitlabWebContext = isTeamNonActionableGitlabWebContext(snapshotQuery.data);
  useEffect(() => {
    if (role === null || !capabilitiesQuery.isSuccess) return;
    const target =
      location.hash === BINDING_HASH || location.hash === "#context-tree"
        ? bindingRef.current
        : location.hash === AUTOMATIC_REVIEW_HASH
          ? automaticReviewRef.current
          : location.hash === CODING_AGENT_ACCESS_HASH
            ? codingAgentAccessRef.current
            : null;
    if (!target) return;
    target.scrollIntoView({ block: "start" });
    target.focus({ preventScroll: true });
  }, [capabilitiesQuery.isSuccess, location.hash, role]);

  if (role === null || !organizationId) {
    return <PageState>Loading…</PageState>;
  }

  if (capabilitiesQuery.isPending) {
    return <PageState>Loading Context Tree settings…</PageState>;
  }

  if (capabilitiesQuery.isError || !binding) {
    return (
      <PageState error>
        {capabilitiesQuery.error instanceof Error
          ? capabilitiesQuery.error.message
          : "Failed to load Context Tree settings"}
      </PageState>
    );
  }

  const review = capabilitiesQuery.data.contextTree.automaticReview;

  return (
    <div
      data-context-tree-settings={isAdmin ? "admin" : "member"}
      className="flex flex-col"
      style={{ gap: "var(--sp-5)", padding: "var(--sp-2) var(--sp-5) var(--sp-7)" }}
    >
      <section
        ref={bindingRef}
        id={BINDING_HASH.slice(1)}
        tabIndex={-1}
        aria-label="Context Tree binding"
        style={{ scrollMarginTop: "var(--sp-4)" }}
      >
        <Section title="Binding" description="The repository and branch that store this Team's shared context.">
          <div style={{ padding: "var(--sp-3) 0" }}>
            {isAdmin ? (
              <SetupContextTreeControls
                key={`context-tree-${organizationId}`}
                binding={binding}
                availability={availability}
                teamNonActionableGitlabWebContext={teamNonActionableGitlabWebContext}
                embedded
              />
            ) : (
              <ReadOnlyBinding binding={binding} />
            )}
          </div>
        </Section>
      </section>

      <section
        ref={automaticReviewRef}
        id={AUTOMATIC_REVIEW_HASH.slice(1)}
        tabIndex={-1}
        aria-label="Automatic Context Tree review"
        style={{ scrollMarginTop: "var(--sp-4)" }}
      >
        <Section
          title="Automatic review"
          description="Choose the Agent that reviews eligible Context Tree pull requests and merge requests."
        >
          <div style={{ padding: "var(--sp-3) 0" }}>
            {review.adoption === "unavailable" ? (
              <p className="text-body" style={{ margin: 0, color: "var(--fg-3)" }}>
                Available once this Team has a valid Context Tree binding.
              </p>
            ) : isAdmin ? (
              <SetupReviewerControls
                key={`automatic-review-${organizationId}`}
                review={review}
                embedded
                label="Enable automatic review"
              />
            ) : (
              <ReadOnlyReview review={review} />
            )}
          </div>
        </Section>
      </section>

      <section
        ref={codingAgentAccessRef}
        id={CODING_AGENT_ACCESS_HASH.slice(1)}
        tabIndex={-1}
        aria-label="Coding agent setup"
        style={{ scrollMarginTop: "var(--sp-4)" }}
      >
        <Section title="Coding agent setup" description="Use this Team's Context Tree in Claude Code or Codex.">
          <div style={{ padding: "var(--sp-3) 0" }}>
            {contextBound ? (
              <ContextPersonalAccess organizationId={organizationId} preparePrompt={preparePrompt} />
            ) : (
              <p className="text-body" style={{ margin: 0, color: "var(--fg-3)" }}>
                Available once this Team has a valid Context Tree binding.
              </p>
            )}
          </div>
        </Section>
      </section>
    </div>
  );
}

function PageState({ children, error = false }: { children: string; error?: boolean }) {
  return (
    <div
      className="text-body"
      role={error ? "alert" : undefined}
      style={{ padding: "var(--sp-5)", color: error ? "var(--state-error)" : "var(--fg-3)" }}
    >
      {children}
    </div>
  );
}

function ReadOnlyBinding({ binding }: { binding: SetupContextTreeBinding }) {
  if (binding.state === "unbound") {
    return (
      <p className="text-body" style={{ margin: 0, color: "var(--fg-3)" }}>
        This Team does not have a Context Tree yet. Ask an admin to set one up.
      </p>
    );
  }
  if (binding.state === "invalid") {
    return (
      <p className="text-body" style={{ margin: 0, color: "var(--fg-3)" }}>
        The Context Tree binding needs repair. Ask an admin to update it.
      </p>
    );
  }
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between" style={{ gap: "var(--sp-3)" }}>
      <div className="min-w-0">
        <div className="text-body font-medium" style={{ color: "var(--success)" }}>
          Connected
        </div>
        <div
          className="text-label"
          style={{ marginTop: "var(--sp-0_5)", color: "var(--fg-3)", overflowWrap: "anywhere" }}
        >
          {repositoryLabel(binding.repo)} · {binding.branch} branch · {providerLabel(binding.provider)}
        </div>
      </div>
      <Button asChild type="button" variant="outline" size="sm">
        <Link to="/context">
          <span>Open Context</span>
          <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
      </Button>
    </div>
  );
}

function ReadOnlyReview({ review }: { review: SetupAutomaticReview }) {
  const enabled = review.adoption === "enabled";
  const status =
    review.adoption === "disabled"
      ? "Off"
      : review.health === "ready"
        ? "On"
        : review.health === "pending_verification"
          ? "Verification pending"
          : review.health === "degraded"
            ? "Degraded"
            : "Unavailable";
  const detail = review.reviewerAgent
    ? `Reviewer · ${review.reviewerAgent.displayName}`
    : enabled
      ? "No reviewer is currently visible."
      : "Optional";
  return (
    <div>
      <div
        className="text-body font-medium"
        style={{ color: enabled && review.health === "ready" ? "var(--success)" : "var(--fg-2)" }}
      >
        {status}
      </div>
      <div className="text-label" style={{ marginTop: "var(--sp-0_5)", color: "var(--fg-3)" }}>
        {detail}
      </div>
    </div>
  );
}

function repositoryLabel(repo: string): string {
  try {
    const url = new URL(repo);
    return url.pathname.replace(/^\/|\.git$/g, "") || url.hostname;
  } catch {
    return repo.replace(/^git@[^:]+:/, "").replace(/\.git$/, "");
  }
}

function providerLabel(provider: "github" | "gitlab"): string {
  return provider === "github" ? "GitHub" : "GitLab";
}
