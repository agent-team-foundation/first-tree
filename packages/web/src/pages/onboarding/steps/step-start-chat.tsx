import type { LandingCampaignActionContext } from "@first-tree/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { listOrgGithubRepos } from "../../../api/github.js";
import { getGithubAppInstallationExists } from "../../../api/github-app.js";
import type { OnboardingFailureReason } from "../../../api/onboarding-events.js";
import { getContextTreeSetting } from "../../../api/org-settings.js";
import { listTeamResourcesForOrg } from "../../../api/resources.js";
import { Avatar } from "../../../components/avatar.js";
import { Button } from "../../../components/ui/button.js";
import { readCampaignActionHandoffFlag, writeCampaignActionHandoffFlag } from "../../../utils/onboarding-flags.js";
import { getCampaign } from "../../quickstart/campaigns.js";
import {
  buildCampaignActionBootstrap,
  buildInviteeReadyBootstrap,
  buildNoRepoBootstrap,
  buildValueFirstBootstrap,
} from "../../workspace/center/onboarding/bootstrap-prose.js";
import { COPY } from "../copy.js";
import { FlowHint } from "../flow-ui.js";
import { type TreeBindingPlan, useOnboardingFlow } from "../onboarding-flow.js";
import { startChatErrorMessage } from "../provision-tree.js";
import { resolveOnboardingAgent } from "../resolve-agent.js";
import { resolveInviteeStartChatState } from "../steps.js";
import { ensureStartChatRepos, type StartChatAgent, startOnboardingChat } from "../tree-setup-chat.js";

/** Shared "create chat + send start-chat bootstrap + finish" sequence for single-chat paths. */
async function runStartChat(args: {
  agent: StartChatAgent;
  bootstrap: string | ((agent: StartChatAgent) => string);
  organizationId: string | null;
  /** Display title for the created chat. */
  topic: string;
  treeBindingPlan?: TreeBindingPlan | "none";
  joinPath?: "invite";
  /** Campaign + repo pair used by both action entry paths for dedup. */
  campaignAction?: LandingCampaignActionContext;
  complete: (chatId: string) => Promise<void>;
}): Promise<void> {
  const bootstrap = typeof args.bootstrap === "function" ? args.bootstrap(args.agent) : args.bootstrap;
  const chatId = await startOnboardingChat({
    agent: args.agent,
    bootstrap,
    organizationId: args.organizationId,
    topic: args.topic,
    treeBindingPlan: args.treeBindingPlan ?? "none",
    joinPath: args.joinPath,
    ...(args.campaignAction ? { campaignAction: args.campaignAction } : {}),
  });
  await args.complete(chatId);
}

export function StepStartChat() {
  const { organizationId, path } = useOnboardingFlow();
  const resolutionInstance = useId();
  const agentQuery = useQuery({
    // Scope the cache to this mounted payoff screen. A later same-org resume
    // must resolve again instead of rendering an agent cached by an older run.
    queryKey: ["onboarding", "start-chat-agent", organizationId, resolutionInstance],
    queryFn: () => resolveOnboardingAgent(organizationId),
    retry: false,
    // The reveal and kickoff must stay bound to one exact object for the life
    // of this screen. A later mount gets a new useId-scoped key and resolves
    // again, but focus/reconnect cannot silently swap the visible target.
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });

  if (agentQuery.isPending) {
    return (
      <p className="text-label" role="status" style={{ margin: 0, color: "var(--fg-3)" }}>
        {COPY.startChat.resolvingAgent}
      </p>
    );
  }

  if (agentQuery.isError) {
    return (
      <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
        <FlowHint tone="error" role="alert">
          {COPY.startChat.resolveAgentFailed}
        </FlowHint>
        <div className="flex">
          <Button type="button" variant="outline" onClick={() => void agentQuery.refetch()}>
            {COPY.startChat.resolveAgentRetry}
          </Button>
        </div>
      </div>
    );
  }

  return path === "admin" ? <AdminStartChat agent={agentQuery.data} /> : <InviteeStartChat agent={agentQuery.data} />;
}

type AgentArrivalProps = {
  agent: StartChatAgent;
  error: string | null;
  onStart: () => void;
  phase: "idle" | "starting";
  preparing?: boolean;
};

export function AgentArrival({ agent, error, onStart, phase, preparing = false }: AgentArrivalProps): ReactNode {
  const displayName = agent.displayName.trim() || agent.name || "Your agent";
  const starting = phase === "starting";

  return (
    <div
      className="flex min-w-0 flex-col"
      data-agent-arrival
      aria-busy={starting || preparing}
      style={{ gap: "var(--sp-6)" }}
    >
      <div className="flex min-w-0 flex-col" style={{ gap: "var(--sp-4)" }}>
        <Avatar src={agent.avatarImageUrl} name={displayName} seed={agent.uuid} size={64} className="shrink-0" />
        <div className="flex min-w-0 flex-col" style={{ gap: "var(--sp-2_5)" }}>
          <p className="text-eyebrow" style={{ margin: 0, color: "var(--fg-3)" }}>
            {COPY.startChat.eyebrow}
          </p>
          <h1 className="text-title font-semibold" style={{ margin: 0, color: "var(--fg)", overflowWrap: "anywhere" }}>
            {COPY.startChat.title(displayName)}
          </h1>
          <p className="text-body" style={{ margin: 0, color: "var(--fg-3)", overflowWrap: "anywhere" }}>
            {COPY.startChat.body(displayName)}
          </p>
        </div>
      </div>

      <div className="flex min-w-0 flex-col" style={{ gap: "var(--sp-3)" }}>
        {error && (
          <FlowHint tone="error" role="alert">
            {error}
          </FlowHint>
        )}
        <div className="flex">
          <Button type="button" variant="cta" onClick={onStart} disabled={starting || preparing}>
            <span>{COPY.startChat.meetAgent}</span>
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
        <p
          className="text-label"
          role={starting || preparing ? "status" : undefined}
          aria-live={starting || preparing ? "polite" : undefined}
          style={{ margin: 0, color: "var(--fg-4)" }}
        >
          {starting ? COPY.startChat.starting : preparing ? COPY.startChat.preparing : COPY.startChat.nextStepHint}
        </p>
      </div>
    </div>
  );
}

// ── Admin ───────────────────────────────────────────────────────────────

function AdminStartChat({ agent }: { agent: StartChatAgent }) {
  const {
    organizationId,
    selectedRepoUrls,
    treeBindingPlan,
    setTreeBindingPlan,
    setTreeUrl,
    treeAutoDetectDone,
    markTreeAutoDetectDone,
    completeAndEnterChat,
    reportStepFailure,
  } = useOnboardingFlow();
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<"form" | "starting">("form");
  const [error, setError] = useState<string | null>(null);

  // Production-scan fix conversion captured by /quickstart (`action=fix`).
  // Read straight off the session flag; cleared once the chat exists so
  // `finishLater` keeps it for a resumed run.
  const [campaignActionHandoff] = useState(() => readCampaignActionHandoffFlag());
  const campaignActionConfig = campaignActionHandoff ? getCampaign(campaignActionHandoff.campaign) : null;

  // `selectedRepoUrls` is only populated by StepConnectCode, which the
  // value-first redesign removed from the onboarding sequence (see steps.ts).
  // So in the live flow `hasRepos` is currently always false and the repo-aware
  // branches below stay dormant — kept intact for when/if a GitHub connect step
  // is re-added to onboarding.
  const hasRepos = selectedRepoUrls.length > 0;

  // Silently detect a bound team Context Tree (a re-run / second admin /
  // CLI-bound tree). There is no "paste your tree URL" path anymore. Detection
  // only decides whether Cloud needs to create/bind a tree repo for the tree
  // setup chat; it never claims the tree already has useful content.
  const treeSettingQuery = useQuery({
    queryKey: ["onboarding", "context-tree", organizationId],
    queryFn: () => getContextTreeSetting(organizationId ?? ""),
    enabled: !!organizationId && hasRepos,
    retry: false,
  });
  const detectedTreeUrl = treeSettingQuery.data?.repo ?? null;
  useEffect(() => {
    // One-shot: when a bound tree is detected, switch to the "use bound tree"
    // plan silently. The done-flag lives in the provider so re-entering this
    // step won't re-fire.
    if (treeAutoDetectDone || !detectedTreeUrl) return;
    markTreeAutoDetectDone();
    setTreeUrl(detectedTreeUrl);
    setTreeBindingPlan("useBoundTree");
  }, [detectedTreeUrl, setTreeUrl, setTreeBindingPlan, treeAutoDetectDone, markTreeAutoDetectDone]);

  const handleStart = async (): Promise<void> => {
    setError(null);
    setPhase("starting");
    let failureReason: OnboardingFailureReason = "start_chat_failed";
    try {
      if (!hasRepos) {
        await runStartChat({
          agent,
          bootstrap: (agent) =>
            campaignActionHandoff && campaignActionConfig
              ? buildCampaignActionBootstrap(
                  agent.displayName || "your agent",
                  campaignActionConfig.action,
                  campaignActionHandoff,
                )
              : buildNoRepoBootstrap(agent.displayName || "your agent"),
          organizationId,
          topic: campaignActionConfig?.action.topic ?? "Get started with First Tree",
          treeBindingPlan: "none",
          ...(campaignActionHandoff?.repoSlug
            ? {
                campaignAction: {
                  campaign: campaignActionHandoff.campaign,
                  repoSlug: campaignActionHandoff.repoSlug,
                },
              }
            : {}),
          complete: async (chatId) => {
            writeCampaignActionHandoffFlag(null);
            await completeAndEnterChat(chatId);
          },
        });
        return;
      }

      // Re-validate the selection against the CURRENT GitHub App grant list
      // before writing any team repo resource. `selectedRepoUrls` may be a
      // restored per-org draft, and the connect-code prune only runs when that
      // step mounts — a flow resumed directly at start-chat (persisted step index)
      // would otherwise register a repo removed from the installation since the
      // user picked it.
      //
      // Fail CLOSED: if we can't read the current grant list (no_installation,
      // suspended, not_configured, upstream 5xx) we cannot prove the selected
      // repos are still accessible, and nothing downstream re-checks grants
      // (`createTeamResourceForOrg` only validates URL shape). So surface a
      // retryable error instead of registering a possibly-stale selection —
      // clicking Start again retries.
      let repos = selectedRepoUrls;
      if (organizationId) {
        failureReason = "repo_access_check_failed";
        const granted = await queryClient
          .fetchQuery({
            queryKey: ["onboarding", "org-github-repos", organizationId],
            queryFn: () => listOrgGithubRepos(organizationId),
            // No `staleTime`: this is the AUTHORITATIVE write-path check, so it
            // must read the current grant list every time, never a cached one.
            // The QueryClient is an app-level singleton and `finishLater` is SPA
            // navigation (not a reload), so the connect-code cache stays alive —
            // reusing it could pass a list minutes-stale relative to grants that
            // changed in another tab / GitHub settings, and write a removed repo.
            // A redundant read on the normal connect-code → start-chat path is the
            // accepted cost of correctness here.
            staleTime: 0,
          })
          .catch(() => {
            throw new Error("Couldn't check your repositories with GitHub just now. Try again in a moment.");
          });
        const grantedUrls = new Set(granted.map((r) => r.cloneUrl));
        repos = selectedRepoUrls.filter((url) => grantedUrls.has(url));
      }

      // Everything the user picked is gone from the installation → nothing to
      // seed a tree from, so fall to the normal first-chat path instead of
      // provisioning a tree from repos the app can no longer access.
      if (repos.length === 0) {
        await runStartChat({
          agent,
          bootstrap: (agent) => buildNoRepoBootstrap(agent.displayName || "your agent"),
          organizationId,
          topic: "Get started with First Tree",
          treeBindingPlan: "none",
          complete: async (chatId) => {
            // Scan-fix handoffs are consumed by the admin fix path only — drop
            // any stale flag once a non-fix first chat exists, so a later
            // onboarding run in this tab cannot consume someone else's scan.
            writeCampaignActionHandoffFlag(null);
            await completeAndEnterChat(chatId);
          },
        });
        return;
      }

      const useBoundTree = treeBindingPlan === "useBoundTree";
      const resolvedTreeBindingPlan = useBoundTree ? "useBoundTree" : "none";
      failureReason = "repo_resource_sync_failed";
      await ensureStartChatRepos(organizationId, repos);

      failureReason = "start_chat_failed";
      const workChatId = await startOnboardingChat({
        agent,
        bootstrap: buildValueFirstBootstrap(repos, {
          agentDisplayName: agent.displayName || "your agent",
          treeSetup: resolvedTreeBindingPlan === "useBoundTree" ? "bound" : "none",
        }),
        organizationId,
        topic: "Get started with First Tree",
        treeBindingPlan: resolvedTreeBindingPlan,
        complete: true,
      });

      await completeAndEnterChat(workChatId);
    } catch (err) {
      setError(startChatErrorMessage(err, COPY.errors.chatFailed));
      setPhase("form");
      reportStepFailure(failureReason, { step: "start-chat" });
    }
  };

  return (
    <AgentArrival
      agent={agent}
      error={error}
      onStart={() => void handleStart()}
      phase={phase === "starting" ? "starting" : "idle"}
      preparing={hasRepos && treeSettingQuery.isLoading}
    />
  );
}

// ── Invitee ─────────────────────────────────────────────────────────────

function InviteeStartChat({ agent }: { agent: StartChatAgent }) {
  const { organizationId, completeAndEnterChat, reportStepFailure } = useOnboardingFlow();
  const [phase, setPhase] = useState<"idle" | "starting">("idle");
  const [error, setError] = useState<string | null>(null);
  // This is the member's already-selected managed-agent path. Readiness here
  // controls only the first First Tree chat; optional external Context access
  // is not part of this managed-agent path.
  //
  // We use the dedicated /github-app-installation/exists endpoint here (returns
  // `{ exists: boolean }`, member-readable) rather than the full installation
  // GET — that one is admin-gated (requireOrgAdmin), so as a non-admin invitee
  // it would 403. Three-state probe: true = installed, false = confirmed
  // missing, null = probe failed (network blip, 5xx). The null sentinel is kept
  // distinct from `false` so the refetchInterval below can tell "don't know yet"
  // from "known missing", and so a transient blip never flips a ready team into
  // not-ready.
  const teamQuery = useQuery({
    queryKey: ["onboarding", "team-config", organizationId],
    queryFn: async () => {
      const [tree, installResult, resources] = await Promise.all([
        getContextTreeSetting(organizationId ?? ""),
        getGithubAppInstallationExists(organizationId ?? "").catch<null>((err) => {
          console.warn("onboarding: installation-exists probe failed", err);
          return null;
        }),
        listTeamResourcesForOrg(organizationId ?? ""),
      ]);
      return {
        treeUrl: tree.repo ?? "",
        hasCodeRepository: resources.some(
          (resource) => resource.type === "repo" && resource.scope === "team" && resource.status === "active",
        ),
        // Optimistic on uncertainty: a probe failure (null) counts as installed
        // so a blip doesn't bounce a ready team into not-ready. `installationKnown`
        // gates the polling so we keep checking until the answer is authoritative.
        hasInstallation: installResult !== false,
        installationKnown: installResult !== null,
      };
    },
    enabled: !!organizationId,
    // Poll while the managed first-chat capability is incomplete.
    refetchInterval: (query) => {
      const d = query.state.data;
      if (!d) return 5000;
      if (!d.installationKnown) return 5000;
      if (!d.treeUrl || !d.hasInstallation || !d.hasCodeRepository) return 5000;
      return false;
    },
  });

  const { treeUrl, hasInstallation, installationKnown, hasCodeRepository } = teamQuery.data ?? {
    treeUrl: "",
    hasInstallation: false,
    installationKnown: false,
    hasCodeRepository: false,
  };
  // "ready" requires an AUTHORITATIVE install=true. `hasInstallation` is optimistic
  // on a failed probe (null → true) so the query keeps polling instead of flapping
  // — but we must NOT render the ready launch (which reads the tree and would 403
  // without an installation) until the probe actually confirms one. Until then
  // the shared arrival keeps the launch in its no-repo mode and the
  // query keeps polling, so the exact same surface advances quietly once the
  // provider capability is confirmed.
  const installed = installationKnown && hasInstallation;
  const ready = resolveInviteeStartChatState({ treeUrl, hasInstallation: installed }) === "ready" && hasCodeRepository;

  const handleStart = async (): Promise<void> => {
    setError(null);
    setPhase("starting");
    try {
      // The agent already inherits the team's repos; a joining teammate's first
      // chat is value-first: read the team's tree/recommended repos, show
      // concrete understanding, then ask which useful first task to do.
      await runStartChat({
        agent,
        bootstrap: (agent) => buildInviteeReadyBootstrap(agent.displayName || "your agent"),
        organizationId,
        topic: "Get settled on First Tree",
        treeBindingPlan: ready ? "useBoundTree" : "none",
        joinPath: "invite",
        complete: async (chatId) => {
          // Scan-fix handoffs are consumed by the admin fix path only — drop
          // any stale flag once a non-fix first chat exists, so a later
          // onboarding run in this tab cannot consume someone else's scan.
          writeCampaignActionHandoffFlag(null);
          await completeAndEnterChat(chatId);
        },
      });
    } catch (err) {
      setError(startChatErrorMessage(err, COPY.errors.chatFailed));
      setPhase("idle");
      reportStepFailure("start_chat_failed", { step: "start-chat" });
    }
  };

  return (
    <AgentArrival
      agent={agent}
      error={error}
      onStart={() => void handleStart()}
      phase={phase}
      preparing={teamQuery.isLoading}
    />
  );
}
