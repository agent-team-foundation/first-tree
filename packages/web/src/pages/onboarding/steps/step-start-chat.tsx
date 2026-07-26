import type { LandingCampaignActionContext } from "@first-tree/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { useEffect, useState } from "react";
import { listOrgGithubRepos } from "../../../api/github.js";
import { getGithubAppInstallationExists } from "../../../api/github-app.js";
import type { OnboardingFailureReason } from "../../../api/onboarding-events.js";
import { getContextTreeSetting } from "../../../api/org-settings.js";
import { CommunityChannels } from "../../../components/community-channels.js";
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
import { FlowHint, StatusRow, StepHeading, WorkingState } from "../flow-ui.js";
import { type TreeBindingPlan, useOnboardingFlow } from "../onboarding-flow.js";
import { startChatErrorMessage } from "../provision-tree.js";
import { resolveOnboardingAgent } from "../resolve-agent.js";
import { resolveInviteeStartChatState } from "../steps.js";
import { ensureStartChatRepos, type StartChatAgent, startOnboardingChat } from "../tree-setup-chat.js";

/** Shared "create chat + send start-chat bootstrap + finish" sequence for single-chat paths. */
async function runStartChat(args: {
  bootstrap: string | ((agent: StartChatAgent) => string);
  /** The selected org — scopes agent resolution so the seed never lands on an
   *  agent from a different org. */
  organizationId: string | null;
  /** Display title for the created chat. */
  topic: string;
  treeBindingPlan?: TreeBindingPlan | "none";
  joinPath?: "invite";
  /** Campaign + repo pair used by both action entry paths for dedup. */
  campaignAction?: LandingCampaignActionContext;
  complete: (chatId: string) => Promise<void>;
}): Promise<void> {
  const agent = await resolveOnboardingAgent(args.organizationId);
  const bootstrap = typeof args.bootstrap === "function" ? args.bootstrap(agent) : args.bootstrap;
  const chatId = await startOnboardingChat({
    agent,
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
  const { path } = useOnboardingFlow();
  return path === "admin" ? <AdminStartChat /> : <InviteeStartChat />;
}

// ── Admin ───────────────────────────────────────────────────────────────

function AdminStartChat() {
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
  const repoCount = selectedRepoUrls.length;

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

  const canStart = phase === "form";

  const handleStart = async (): Promise<void> => {
    setError(null);
    setPhase("starting");
    let failureReason: OnboardingFailureReason = "start_chat_failed";
    try {
      if (!hasRepos) {
        await runStartChat({
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
      const agent = await resolveOnboardingAgent(organizationId);
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

  if (phase === "starting") return <StartingState />;

  // No repo connected is now a normal value-first path. The user can start
  // chatting and share a project path or GitHub URL in the agent chat; GitHub
  // access is no longer a required onboarding chore.
  if (!hasRepos) {
    return (
      <div className="flex flex-col" style={{ gap: "var(--sp-6)" }}>
        <StepHeading title={COPY.startChat.noProjectTitle} why={COPY.startChat.noProjectBody} />
        <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
          {error && (
            <FlowHint tone="error" role="alert">
              {error}
            </FlowHint>
          )}
          <div className="flex">
            <Button type="button" variant="cta" onClick={() => void handleStart()} disabled={!canStart}>
              <span>{COPY.startChat.startChatting}</span>
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
          <CommunityBlock />
        </div>
      </div>
    );
  }

  // Wait for the bound-tree probe so we don't flash "create" then flip to
  // "bound".
  if (treeSettingQuery.isLoading) {
    return <StatusRow state="waiting" label="Checking your team's setup…" />;
  }

  const usesBoundTree = treeBindingPlan === "useBoundTree";
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-6)" }}>
      <StepHeading
        title={usesBoundTree ? COPY.startChat.existingTitle : COPY.startChat.newTitle}
        why={usesBoundTree ? COPY.startChat.existingWhy(repoCount) : COPY.startChat.newWhy(repoCount)}
      />
      <div className="flex flex-col" style={{ gap: "var(--sp-5)" }}>
        {error && (
          <FlowHint tone="error" role="alert">
            {error}
          </FlowHint>
        )}
        <div className="flex">
          <Button type="button" variant="cta" onClick={() => void handleStart()} disabled={!canStart}>
            <span>{usesBoundTree ? COPY.startChat.startExisting : COPY.startChat.startBuilding}</span>
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
        <CommunityBlock />
      </div>
    </div>
  );
}

// ── Invitee ─────────────────────────────────────────────────────────────

function InviteeStartChat() {
  const { organizationId } = useOnboardingFlow();
  // The team is "ready" only with BOTH a Context Tree and a GitHub connection;
  // either missing → "not-ready". The install bit matters because a tree without
  // an installation would 403 the agent's first git op, so we hold rather than
  // launch into a broken state.
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
      const [tree, installResult] = await Promise.all([
        getContextTreeSetting(organizationId ?? ""),
        getGithubAppInstallationExists(organizationId ?? "").catch<null>((err) => {
          console.warn("onboarding: installation-exists probe failed", err);
          return null;
        }),
      ]);
      return {
        treeUrl: tree.repo ?? "",
        // Optimistic on uncertainty: a probe failure (null) counts as installed
        // so a blip doesn't bounce a ready team into not-ready. `installationKnown`
        // gates the polling so we keep checking until the answer is authoritative.
        hasInstallation: installResult !== false,
        installationKnown: installResult !== null,
      };
    },
    enabled: !!organizationId,
    // Poll until the team is genuinely ready: a tree URL AND an authoritative
    // (non-null) probe that came back installed. While either is missing or
    // unknown, keep polling — so the moment the admin finishes whichever half
    // was missing, this flips to "ready" on its own (the old code stopped
    // polling once the tree appeared, stranding the no-install case).
    refetchInterval: (query) => {
      const d = query.state.data;
      if (!d) return 5000;
      if (!d.installationKnown) return 5000;
      if (!d.treeUrl || !d.hasInstallation) return 5000;
      return false;
    },
  });

  if (teamQuery.isLoading) {
    return <StatusRow state="waiting" label="Checking what your team has set up…" />;
  }

  // Read failure → not-ready; the query keeps polling so a transient blip
  // resolves on its own.
  if (teamQuery.isError || !teamQuery.data) {
    return <InviteeNotReady />;
  }

  const { treeUrl, hasInstallation, installationKnown } = teamQuery.data;
  // "ready" requires an AUTHORITATIVE install=true. `hasInstallation` is optimistic
  // on a failed probe (null → true) so the query keeps polling instead of flapping
  // — but we must NOT render the ready launch (which reads the tree and would 403
  // without an installation) until the probe actually confirms one. Until then,
  // not-ready holds: it offers a simple first chat (no git op, no 403) and keeps
  // polling, so it advances to ready on its own once install is confirmed.
  const installed = installationKnown && hasInstallation;
  return resolveInviteeStartChatState({ treeUrl, hasInstallation: installed }) === "ready" ? (
    <InviteeReady />
  ) : (
    <InviteeNotReady />
  );
}

/**
 * Invitee · ready to launch. The team has a Context Tree and a GitHub
 * connection, so there's nothing left to set up — and nothing to pick: the
 * agent already inherits the team's `recommended` repo resources automatically
 * (they're enabled for every org agent). This mirrors the admin finale as a
 * pure launch into a real chat. An invitee never mutates team config.
 */
function InviteeReady() {
  const { organizationId, completeAndEnterChat, reportStepFailure } = useOnboardingFlow();
  const [phase, setPhase] = useState<"idle" | "starting">("idle");
  const [error, setError] = useState<string | null>(null);

  const handleStart = async (): Promise<void> => {
    setError(null);
    setPhase("starting");
    try {
      // The agent already inherits the team's repos; a joining teammate's first
      // chat is value-first: read the team's tree/recommended repos, show
      // concrete understanding, then ask which useful first task to do.
      await runStartChat({
        bootstrap: (agent) => buildInviteeReadyBootstrap(agent.displayName || "your agent"),
        organizationId,
        topic: "Get settled on First Tree",
        treeBindingPlan: "useBoundTree",
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

  if (phase === "starting") return <StartingState />;

  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-6)" }}>
      <StepHeading title={COPY.startChat.inviteeReadyTitle} why={COPY.startChat.inviteeReadyBody} />
      <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
        {error && (
          <FlowHint tone="error" role="alert">
            {error}
          </FlowHint>
        )}
        <div className="flex">
          <Button type="button" variant="cta" onClick={() => void handleStart()}>
            <span>{COPY.startChat.startWorking}</span>
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
        <CommunityBlock />
      </div>
    </div>
  );
}

/**
 * Invitee · the team's workspace isn't ready yet — either no Context Tree or no
 * GitHub connection. We don't split those: in both cases the invitee is blocked
 * on the admin and can't act on it, so one screen covers both. The start-chat query
 * keeps polling, so this advances to `ready` on its own the moment the admin
 * finishes whichever half was missing.
 *
 * The primary action starts a real first chat with the agent. Routing it through
 * `completeAndEnterChat` — not `finishLater` — means the button lands the user
 * in a real chat WITH the agent, instead of dropping them into an empty workspace.
 */
function InviteeNotReady() {
  const { organizationId, completeAndEnterChat, reportStepFailure } = useOnboardingFlow();
  const [phase, setPhase] = useState<"idle" | "starting">("idle");
  const [error, setError] = useState<string | null>(null);

  const handleMeet = async (): Promise<void> => {
    setError(null);
    setPhase("starting");
    try {
      await runStartChat({
        bootstrap: (agent) => buildInviteeReadyBootstrap(agent.displayName || "your agent"),
        organizationId,
        topic: "Get settled on First Tree",
        treeBindingPlan: "none",
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

  if (phase === "starting") return <StartingState />;

  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-6)" }}>
      <StepHeading title={COPY.invitee.notReadyTitle} why={COPY.invitee.notReadyBody} />
      <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
        {error && (
          <FlowHint tone="error" role="alert">
            {error}
          </FlowHint>
        )}
        {/* The primary action is not an escape hatch: the common not-ready case
            (admin finished without a tree) never resolves, so the real path
            forward is to start now. If the team does finish, the page still
            advances on its own — quietly, no longer announced. */}
        <div className="flex">
          <Button type="button" variant="cta" onClick={() => void handleMeet()}>
            <span>{COPY.invitee.startAnyway}</span>
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
        <CommunityBlock />
      </div>
    </div>
  );
}

// ── shared ──────────────────────────────────────────────────────────────

function StartingState() {
  return <WorkingState label={COPY.startChat.starting} />;
}

/**
 * "Join the community" — the two channel cards (WeChat / Discord, see
 * CommunityChannels) as a footer under the launch CTA. Rendered only in the
 * stable finale bodies (never during loading/starting transitions), separated
 * from the primary action by a hairline so it reads as a footer and can't
 * compete with "Start chat".
 */
function CommunityBlock() {
  return (
    <div
      className="flex flex-col"
      style={{
        gap: "var(--sp-3)",
        marginTop: "var(--sp-5)",
        paddingTop: "var(--sp-5)",
        borderTop: "var(--hairline) solid var(--border)",
      }}
    >
      <span className="text-label font-medium" style={{ color: "var(--fg-3)" }}>
        {COPY.startChat.community.title}
      </span>
      <CommunityChannels />
    </div>
  );
}
