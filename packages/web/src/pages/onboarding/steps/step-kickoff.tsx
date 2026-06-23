import type { KickoffKind } from "@first-tree/shared";
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { listOrgGithubRepos } from "../../../api/github.js";
import { getGithubAppInstallationExists } from "../../../api/github-app.js";
import { kickoffOnboarding, reportOnboardingEvent } from "../../../api/onboarding-events.js";
import { getContextTreeSetting } from "../../../api/org-settings.js";
import { Button } from "../../../components/ui/button.js";
import {
  buildInviteeReadyBootstrap,
  buildNoRepoBootstrap,
  buildTreeSetupBootstrap,
  buildValueFirstBootstrap,
} from "../../workspace/center/onboarding/bootstrap-prose.js";
import { COPY } from "../copy.js";
import { FlowHint, StatusRow, StepHeading, WorkingState } from "../flow-ui.js";
import { type TreeBindingPlan, useOnboardingFlow } from "../onboarding-flow.js";
import { ensureSourceReposRegistered, kickoffErrorMessage, provisionNewTree } from "../provision-tree.js";
import { resolveOnboardingAgent } from "../resolve-agent.js";
import { resolveInviteeKickoffState } from "../steps.js";

type KickoffAgent = Awaited<ReturnType<typeof resolveOnboardingAgent>>;

async function ensureKickoffRepos(organizationId: string | null, sourceRepos: readonly string[]): Promise<void> {
  if (!organizationId || sourceRepos.length === 0) return;
  await ensureSourceReposRegistered(organizationId, sourceRepos);
}

async function ensureTreeBindingForSetup(args: {
  organizationId: string;
  treeBindingPlan: TreeBindingPlan;
  detectedTreeUrl: string | null;
}): Promise<string | null> {
  if (args.treeBindingPlan === "createBinding") {
    await provisionNewTree(args.organizationId);
  }
  const setting = await getContextTreeSetting(args.organizationId).catch(() => null);
  return setting?.repo ?? args.detectedTreeUrl;
}

async function startKickoffChat(args: {
  agent: KickoffAgent;
  bootstrap: string;
  /** The selected org — scopes the membership completion stamped by the server. */
  organizationId: string | null;
  /** "intro" = meet-only; "work" = value-first first chat; "tree" = Context Tree setup/update chat. */
  kind: KickoffKind;
  treeBindingPlan: TreeBindingPlan | "none";
  joinPath?: "invite";
  complete?: boolean;
}): Promise<string> {
  // Create-or-reuse the kickoff chat and send the bootstrap in one idempotent
  // server call. Value-first work/intro paths can let the server stamp
  // completion after the user-facing chat exists; background tree setup passes
  // `complete: false` because it should not control the user's first-chat entry.
  // A failure here surfaces to the caller rather than being swallowed.
  const { chatId } = await kickoffOnboarding({
    ...(args.organizationId ? { organizationId: args.organizationId } : {}),
    agentUuid: args.agent.uuid,
    bootstrap: args.bootstrap,
    kind: args.kind,
    complete: args.complete,
  });
  void reportOnboardingEvent("kickoff_chat_started", {
    agentUuid: args.agent.uuid,
    chatId,
    treeBindingPlan: args.treeBindingPlan,
    kind: args.kind,
    ...(args.joinPath ? { joinPath: args.joinPath } : {}),
  });
  return chatId;
}

async function startTreeSetupKickoff(args: {
  agent: KickoffAgent;
  organizationId: string;
  sourceRepos: readonly string[];
  treeBindingPlan: TreeBindingPlan;
  detectedTreeUrl: string | null;
  queryClient: QueryClient;
  complete?: boolean;
}): Promise<string> {
  const treeUrl = await ensureTreeBindingForSetup({
    organizationId: args.organizationId,
    treeBindingPlan: args.treeBindingPlan,
    detectedTreeUrl: args.detectedTreeUrl,
  });
  args.queryClient.removeQueries({ queryKey: ["org-setting", args.organizationId, "context_tree"] });
  args.queryClient.removeQueries({ queryKey: ["onboarding", "context-tree", args.organizationId] });
  args.queryClient.removeQueries({ queryKey: ["me", "onboarding", "tree-setup-status", args.organizationId] });
  const chatId = await startKickoffChat({
    agent: args.agent,
    bootstrap: buildTreeSetupBootstrap(args.sourceRepos, {
      treeBindingPlan: args.treeBindingPlan,
      treeUrl,
    }),
    organizationId: args.organizationId,
    kind: "tree",
    treeBindingPlan: args.treeBindingPlan,
    complete: args.complete,
  });
  args.queryClient.removeQueries({ queryKey: ["me", "onboarding", "tree-setup-status", args.organizationId] });
  return chatId;
}

/** Shared "create chat + send kickoff + finish" sequence for single-chat paths. */
async function runKickoff(args: {
  bootstrap: string | ((agent: KickoffAgent) => string);
  /** The selected org — scopes agent resolution so the seed never lands on an
   *  agent from a different org (notably the build-tree recovery surface). */
  organizationId: string | null;
  /** "intro" = meet-only; "work" = value-first first chat; "tree" = Context Tree setup/update chat. */
  kind: KickoffKind;
  treeBindingPlan?: TreeBindingPlan | "none";
  joinPath?: "invite";
  complete: (chatId: string) => Promise<void>;
}): Promise<void> {
  const agent = await resolveOnboardingAgent(args.organizationId);
  const bootstrap = typeof args.bootstrap === "function" ? args.bootstrap(agent) : args.bootstrap;
  const chatId = await startKickoffChat({
    agent,
    bootstrap,
    organizationId: args.organizationId,
    kind: args.kind,
    treeBindingPlan: args.treeBindingPlan ?? "none",
    joinPath: args.joinPath,
  });
  await args.complete(chatId);
}

/**
 * `recovery` (set ONLY by the standalone /build-tree surface) suppresses the
 * per-step heading — the recovery shell supplies the constant "Build your team's
 * Context Tree" title. `agentPicker` is an optional slot rendered just above the
 * CTA — the recovery surface passes its "which agent builds the tree?" control
 * here, so the choice sits with the build action. Onboarding renders
 * `<StepKickoff />` with neither prop — unchanged. (The existing-tree fork was
 * already removed for everyone in PR 943, so there's no extra path to hide here.)
 */
export function StepKickoff({
  recovery,
  agentPicker,
  buildDisabled,
}: {
  recovery?: boolean;
  agentPicker?: ReactNode;
  buildDisabled?: boolean;
} = {}) {
  const { path } = useOnboardingFlow();
  return path === "admin" ? (
    <AdminKickoff recovery={recovery} agentPicker={agentPicker} buildDisabled={buildDisabled} />
  ) : (
    <InviteeKickoff />
  );
}

// ── Admin ───────────────────────────────────────────────────────────────

function AdminKickoff({
  recovery,
  agentPicker,
  buildDisabled,
}: {
  recovery?: boolean;
  agentPicker?: ReactNode;
  buildDisabled?: boolean;
}) {
  const {
    organizationId,
    selectedRepoUrls,
    treeBindingPlan,
    setTreeBindingPlan,
    treeUrl,
    setTreeUrl,
    treeAutoDetectDone,
    markTreeAutoDetectDone,
    completeAndEnterChat,
    goTo,
    sequence,
  } = useOnboardingFlow();
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<"form" | "starting">("form");
  const [error, setError] = useState<string | null>(null);

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
    try {
      if (!hasRepos) {
        await runKickoff({
          bootstrap: (agent) => buildNoRepoBootstrap(agent.displayName || "your agent"),
          organizationId,
          kind: "intro",
          treeBindingPlan: "none",
          complete: completeAndEnterChat,
        });
        return;
      }

      // Re-validate the selection against the CURRENT GitHub App grant list
      // before writing any team repo resource. `selectedRepoUrls` may be a
      // restored per-org draft, and the connect-code prune only runs when that
      // step mounts — a flow resumed directly at kickoff (persisted step index)
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
            // A redundant read on the normal connect-code → kickoff path is the
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
      // seed a tree from, so fall to the intro path instead of provisioning a
      // tree from repos the app can no longer access.
      if (repos.length === 0) {
        await runKickoff({
          bootstrap: (agent) => buildNoRepoBootstrap(agent.displayName || "your agent"),
          organizationId,
          kind: "intro",
          treeBindingPlan: "none",
          complete: completeAndEnterChat,
        });
        return;
      }

      const useBoundTree = treeBindingPlan === "useBoundTree";
      const detectedUrl = useBoundTree ? treeUrl.trim() || null : null;
      const resolvedTreeBindingPlan = useBoundTree ? "useBoundTree" : "createBinding";
      const agent = await resolveOnboardingAgent(organizationId);
      await ensureKickoffRepos(organizationId, repos);

      if (recovery) {
        if (!organizationId) throw new Error(COPY.errors.chatFailed);
        const treeChatId = await startTreeSetupKickoff({
          agent,
          organizationId,
          sourceRepos: repos,
          treeBindingPlan: resolvedTreeBindingPlan,
          detectedTreeUrl: detectedUrl,
          queryClient,
          complete: true,
        });
        await completeAndEnterChat(treeChatId);
        return;
      }

      const workChatId = await startKickoffChat({
        agent,
        bootstrap: buildValueFirstBootstrap(repos, {
          agentDisplayName: agent.displayName || "your agent",
          treeSetup: resolvedTreeBindingPlan === "createBinding" ? "pending" : "bound",
        }),
        organizationId,
        kind: "work",
        treeBindingPlan: resolvedTreeBindingPlan,
        complete: true,
      });

      if (organizationId) {
        void startTreeSetupKickoff({
          agent,
          organizationId,
          sourceRepos: repos,
          treeBindingPlan: resolvedTreeBindingPlan,
          detectedTreeUrl: detectedUrl,
          queryClient,
          complete: false,
        }).catch((err) => {
          console.warn("onboarding: tree setup kickoff failed after work chat started", err);
        });
      }
      await completeAndEnterChat(workChatId);
    } catch (err) {
      setError(kickoffErrorMessage(err, COPY.errors.chatFailed));
      setPhase("form");
    }
  };

  if (phase === "starting") return <StartingState />;

  // No repo connected — same state as "no Context Tree". The title is honest
  // (the agent works, but the team has no tree), and the recovery — go back to
  // connect-code and connect GitHub — lives INLINE in the body (not a separate
  // orphaned link below the CTA), the same pre/link/post idiom as create-agent's
  // "reconnect it".
  if (!hasRepos) {
    return (
      <div className="flex flex-col" style={{ gap: "var(--sp-6)" }}>
        <StepHeading
          title={COPY.kickoff.noProjectTitle}
          why={
            <>
              {COPY.kickoff.noProjectBody.pre}
              <button
                type="button"
                className="font-medium underline underline-offset-2"
                style={{ color: "var(--primary)" }}
                onClick={() => goTo(sequence.indexOf("connect-code"))}
              >
                {COPY.kickoff.noProjectBody.link}
              </button>
              {COPY.kickoff.noProjectBody.post}
            </>
          }
        />
        <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
          {error && (
            <FlowHint tone="error" role="alert">
              {error}
            </FlowHint>
          )}
          <div className="flex">
            <Button type="button" variant="cta" onClick={() => void handleStart()} disabled={!canStart}>
              <span>{COPY.kickoff.startChatting}</span>
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
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
      {/* Recovery suppresses the per-step heading — its shell supplies the
          constant "Build your team's Context Tree" title. */}
      <StepHeading
        title={recovery ? "" : usesBoundTree ? COPY.kickoff.existingTitle : COPY.kickoff.newTitle}
        why={usesBoundTree ? COPY.kickoff.existingWhy(repoCount) : COPY.kickoff.newWhy(repoCount)}
      />
      <div className="flex flex-col" style={{ gap: "var(--sp-5)" }}>
        {/* Recovery's "which agent builds the tree?" control sits here, right
            above the CTA. Undefined (renders nothing) in onboarding. */}
        {agentPicker}
        {error && (
          <FlowHint tone="error" role="alert">
            {error}
          </FlowHint>
        )}
        <div className="flex">
          <Button type="button" variant="cta" onClick={() => void handleStart()} disabled={!canStart || buildDisabled}>
            <span>{usesBoundTree ? COPY.kickoff.startExisting : COPY.kickoff.startBuilding}</span>
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Invitee ─────────────────────────────────────────────────────────────

function InviteeKickoff() {
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
  // not-ready holds: it offers an intro-only "meet your agent" (no git op, no 403)
  // and keeps polling, so it advances to ready on its own once install is confirmed.
  const installed = installationKnown && hasInstallation;
  return resolveInviteeKickoffState({ treeUrl, hasInstallation: installed }) === "ready" ? (
    <InviteeReady treeUrl={treeUrl} />
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
function InviteeReady({ treeUrl }: { treeUrl: string }) {
  const { organizationId, completeAndEnterChat } = useOnboardingFlow();
  const [phase, setPhase] = useState<"idle" | "starting">("idle");
  const [error, setError] = useState<string | null>(null);

  const handleStart = async (): Promise<void> => {
    setError(null);
    setPhase("starting");
    try {
      // The agent already inherits the team's repos; a joining teammate's first
      // chat is value-first: read the team's tree/recommended repos, show
      // concrete understanding, then ask which useful first task to do.
      await runKickoff({
        bootstrap: (agent) => buildInviteeReadyBootstrap(agent.displayName || "your agent", treeUrl),
        organizationId,
        kind: "work",
        treeBindingPlan: "useBoundTree",
        joinPath: "invite",
        complete: completeAndEnterChat,
      });
    } catch (err) {
      setError(kickoffErrorMessage(err, COPY.errors.chatFailed));
      setPhase("idle");
    }
  };

  if (phase === "starting") return <StartingState />;

  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-6)" }}>
      <StepHeading title={COPY.kickoff.inviteeReadyTitle} why={COPY.kickoff.inviteeReadyBody} />
      <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
        {error && (
          <FlowHint tone="error" role="alert">
            {error}
          </FlowHint>
        )}
        <div className="flex">
          <Button type="button" variant="cta" onClick={() => void handleStart()}>
            <span>{COPY.kickoff.startWorking}</span>
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Invitee · the team's workspace isn't ready yet — either no Context Tree or no
 * GitHub connection. We don't split those: in both cases the invitee is blocked
 * on the admin and can't act on it, so one screen covers both. The kickoff query
 * keeps polling, so this advances to `ready` on its own the moment the admin
 * finishes whichever half was missing.
 *
 * "Meet your agent" runs an intro-only kickoff (`runKickoff` with no repo → an
 * agent that introduces itself, repos connectable later from Settings), the same
 * launch the `ready` state uses. Routing it through `completeAndEnterChat` — not
 * `finishLater` — means the button lands the user in a real chat WITH the agent,
 * instead of dropping them into an empty workspace.
 */
function InviteeNotReady() {
  const { organizationId, completeAndEnterChat } = useOnboardingFlow();
  const [phase, setPhase] = useState<"idle" | "starting">("idle");
  const [error, setError] = useState<string | null>(null);

  const handleMeet = async (): Promise<void> => {
    setError(null);
    setPhase("starting");
    try {
      await runKickoff({
        bootstrap: (agent) => buildNoRepoBootstrap(agent.displayName || "your agent"),
        organizationId,
        kind: "intro",
        treeBindingPlan: "none",
        joinPath: "invite",
        complete: completeAndEnterChat,
      });
    } catch (err) {
      setError(kickoffErrorMessage(err, COPY.errors.chatFailed));
      setPhase("idle");
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
        {/* "Meet your agent" is the PRIMARY action, not an escape hatch: the
            common not-ready case (admin finished without a tree) never resolves,
            so the real path forward is to start now. If the team does finish,
            the page still advances on its own — quietly, no longer announced. */}
        <div className="flex">
          <Button type="button" variant="cta" onClick={() => void handleMeet()}>
            <span>{COPY.invitee.startAnyway}</span>
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── shared ──────────────────────────────────────────────────────────────

function StartingState() {
  return <WorkingState label={COPY.kickoff.starting} />;
}
