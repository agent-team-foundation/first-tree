import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { useEffect, useState } from "react";
import { createAgentChat, sendChatMessage } from "../../../api/chats.js";
import { getGithubAppInstallationExists } from "../../../api/github-app.js";
import { reportOnboardingEvent } from "../../../api/onboarding-events.js";
import { getContextTreeSetting, putContextTreeSetting } from "../../../api/org-settings.js";
import { createTeamResourceForOrg, listTeamResourcesForOrg } from "../../../api/resources.js";
import { Button } from "../../../components/ui/button.js";
import {
  buildBindBootstrap,
  buildCreateBootstrap,
  buildInviteeBootstrap,
} from "../../workspace/center/onboarding/bootstrap-prose.js";
import { COPY } from "../copy.js";
import { FlowHint, StatusRow, StepHeading, WorkingState } from "../flow-ui.js";
import { useOnboardingFlow } from "../onboarding-flow.js";
import { ensureSourceReposRegistered, kickoffErrorMessage, provisionNewTree, repoLabel } from "../provision-tree.js";
import { resolveOnboardingAgent } from "../resolve-agent.js";
import { resolveInviteeKickoffState } from "../steps.js";

const NO_REPO_BOOTSTRAP =
  "Introduce yourself to the team — what can you help with, and what's a good first thing for me to try?";

function teamRecommendedRepoUrls(resources: Awaited<ReturnType<typeof listTeamResourcesForOrg>>): string[] {
  return resources
    .filter((resource) => resource.type === "repo" && resource.defaultEnabled === "recommended")
    .map((resource) => {
      const payload = resource.payload as { url?: unknown };
      return typeof payload.url === "string" ? payload.url : null;
    })
    .filter((url): url is string => Boolean(url));
}

/** Shared "create the chat + send the first task + finish" sequence. */
async function runKickoff(args: {
  bootstrap: string;
  orgWrites: { organizationId: string; sourceRepos: string[]; contextTreeUrl: string | null } | null;
  treeMode: "new" | "existing";
  joinPath?: "invite";
  complete: (chatId: string) => Promise<void>;
}): Promise<void> {
  const agent = await resolveOnboardingAgent();

  // New-tree mode: provision the team's Context Tree repo + org binding BEFORE
  // sending the kickoff message, so the agent's session resolves the binding
  // (contextTreePath becomes non-null) and `first-tree-seed`'s preconditions
  // hold. Only fires when there are repos to seed from — the no-project path
  // has no `orgWrites` and nothing to seed. `provisionNewTree` treats an
  // already-provisioned tree (a retry after a later step failed, or a
  // detect→create race) as success and re-throws every real failure (e.g. the
  // GitHub App installation isn't an org with repo-admin) so the user sees an
  // actionable error and can retry — nothing is half-created (no chat yet).
  if (args.treeMode === "new" && args.orgWrites?.organizationId) {
    await provisionNewTree(args.orgWrites.organizationId);
  }

  // Org-level writes. The context-tree-URL cache is best-effort. Source-repo
  // resources are best-effort for an EXISTING tree (a convenience cache for
  // future teammates), but REQUIRED for a NEW tree — they're the only path by
  // which the selected repos reach the agent's gitRepos / on-disk sources /
  // workspace.json that `first-tree-seed` needs, so a dropped write must
  // surface as a retryable error rather than an empty/incomplete seed.
  if (args.orgWrites) {
    const orgWrites = args.orgWrites;
    if (orgWrites.sourceRepos.length > 0) {
      if (args.treeMode === "new") {
        await ensureSourceReposRegistered(orgWrites.organizationId, orgWrites.sourceRepos);
      } else {
        await Promise.allSettled(
          orgWrites.sourceRepos.map((url) =>
            createTeamResourceForOrg(orgWrites.organizationId, {
              type: "repo",
              name: repoLabel(url),
              defaultEnabled: "recommended",
              payload: { url },
            }),
          ),
        );
      }
    }
    if (orgWrites.contextTreeUrl) {
      await putContextTreeSetting(orgWrites.organizationId, { repo: orgWrites.contextTreeUrl }).catch(() => {});
    }
  }

  const chat = await createAgentChat(agent.uuid);
  try {
    // `createAgentChat` constructs a 1:1 chat with the bootstrap agent —
    // declare the agent as the explicit recipient so the server's
    // explicit-recipient enforcement check passes (the legacy 1:1 implicit-wake
    // bypass is gone). Without this, the kickoff message would 400.
    await sendChatMessage(chat.id, args.bootstrap, [agent.uuid]);
  } catch (err) {
    // Non-fatal: the chat exists; the agent introduces itself when the user
    // types. Log so operators can triage a silently-missing first message.
    console.warn("onboarding: failed to send kickoff bootstrap message", err);
  }
  void reportOnboardingEvent("tree_chat_started", {
    agentUuid: agent.uuid,
    chatId: chat.id,
    treeMode: args.treeMode,
    ...(args.joinPath ? { joinPath: args.joinPath } : {}),
  });
  await args.complete(chat.id);
}

export function StepKickoff() {
  const { path } = useOnboardingFlow();
  return path === "admin" ? <AdminKickoff /> : <InviteeKickoff />;
}

// ── Admin ───────────────────────────────────────────────────────────────

function AdminKickoff() {
  const {
    organizationId,
    selectedRepoUrls,
    treeMode,
    setTreeMode,
    treeUrl,
    setTreeUrl,
    treeAutoInitDone,
    markTreeAutoInitDone,
    completeAndEnterChat,
    goTo,
    sequence,
  } = useOnboardingFlow();
  const [phase, setPhase] = useState<"form" | "starting">("form");
  const [error, setError] = useState<string | null>(null);

  const hasRepos = selectedRepoUrls.length > 0;
  const repoCount = selectedRepoUrls.length;

  // Silently detect an existing team Context Tree (a re-run / second admin /
  // CLI-bound tree). There is no "paste your tree URL" path anymore — a team's
  // tree is always one we provision — so detection only switches the agent's
  // first task from "seed a new tree" to "read the existing one"; it never asks
  // the user to choose. retry:false so a "no tree yet" miss falls through fast.
  const treeSettingQuery = useQuery({
    queryKey: ["onboarding", "context-tree", organizationId],
    queryFn: () => getContextTreeSetting(organizationId ?? ""),
    enabled: !!organizationId && hasRepos,
    retry: false,
  });
  const detectedTreeUrl = treeSettingQuery.data?.repo ?? null;
  useEffect(() => {
    // One-shot: when an existing tree is detected, switch to the "read it"
    // bootstrap silently. The done-flag lives in the provider so re-entering
    // this step won't re-fire.
    if (treeAutoInitDone || !detectedTreeUrl) return;
    markTreeAutoInitDone();
    setTreeUrl(detectedTreeUrl);
    setTreeMode("existing");
  }, [detectedTreeUrl, setTreeUrl, setTreeMode, treeAutoInitDone, markTreeAutoInitDone]);

  const canStart = phase === "form";

  const handleStart = async (): Promise<void> => {
    setError(null);
    setPhase("starting");
    try {
      if (!hasRepos) {
        await runKickoff({
          bootstrap: NO_REPO_BOOTSTRAP,
          orgWrites: null,
          treeMode: "new",
          complete: completeAndEnterChat,
        });
        return;
      }
      const useExisting = treeMode === "existing";
      const detectedUrl = treeUrl.trim();
      const bootstrap = useExisting
        ? buildBindBootstrap(selectedRepoUrls, detectedUrl)
        : buildCreateBootstrap(selectedRepoUrls);
      await runKickoff({
        bootstrap,
        orgWrites: organizationId
          ? {
              organizationId,
              sourceRepos: selectedRepoUrls,
              contextTreeUrl: useExisting ? detectedUrl : null,
            }
          : null,
        treeMode: useExisting ? "existing" : "new",
        complete: completeAndEnterChat,
      });
    } catch (err) {
      setError(kickoffErrorMessage(err, COPY.errors.chatFailed));
      setPhase("form");
    }
  };

  if (phase === "starting") return <StartingState />;

  // No repo connected — nothing to seed a tree from, so this is honestly just
  // "meet your agent". A quiet affordance points back to connect-code (the only
  // way to give the team a Context Tree), not a silent "do it later in Settings".
  if (!hasRepos) {
    return (
      <div className="flex flex-col" style={{ gap: "var(--sp-6)" }}>
        <StepHeading title={COPY.kickoff.noProjectTitle} why={COPY.kickoff.noProjectBody} />
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
          {/* Standalone affordance back to connect-code (where they can pick a
              repo, then Continue returns here with one). A persistent underline
              makes it read as a clickable link, not a heading. */}
          <Button
            type="button"
            variant="link"
            className="h-auto self-start p-0 text-label underline underline-offset-2"
            onClick={() => goTo(sequence.indexOf("connect-code"))}
          >
            {COPY.kickoff.connectRepoAffordance}
          </Button>
        </div>
      </div>
    );
  }

  // Wait for the existing-tree probe so we don't flash "new" then flip to "read".
  if (treeSettingQuery.isLoading) {
    return <StatusRow state="waiting" label="Checking your team's setup…" />;
  }

  const isExisting = treeMode === "existing";
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-6)" }}>
      <StepHeading
        title={isExisting ? COPY.kickoff.existingTitle : COPY.kickoff.newTitle}
        why={isExisting ? COPY.kickoff.existingWhy(repoCount) : COPY.kickoff.newWhy(repoCount)}
      />
      <div className="flex flex-col" style={{ gap: "var(--sp-5)" }}>
        {error && (
          <FlowHint tone="error" role="alert">
            {error}
          </FlowHint>
        )}
        <div className="flex">
          <Button type="button" variant="cta" onClick={() => void handleStart()} disabled={!canStart}>
            <span>{isExisting ? COPY.kickoff.startExisting : COPY.kickoff.startBuilding}</span>
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
  // Fetch tree config, team repos, and installation existence together.
  // The installation bit drives the "no-installation" sub-state, which catches
  // "admin set up the tree but never connected GitHub" before the invitee
  // launches and the agent hits a 403 on its first git op.
  //
  // We use the dedicated /github-app-installation/exists endpoint here
  // (returns `{ exists: boolean }`, member-readable) rather than the full
  // installation GET — that one is admin-gated (requireOrgAdmin), so as a
  // non-admin invitee it would 403. Round 1 of codex review caught that
  // mapping 403→"missing" blocks every invitee of a healthy team; round 2
  // caught that mapping 403→"installed" makes the new safeguard
  // unreachable. The /exists endpoint side-steps both by exposing just the
  // presence bit to members. Any unexpected error here falls through to
  // `hasInstallation: true` so a transient blip never bounces the user
  // into the wrong sub-state.
  const teamQuery = useQuery({
    queryKey: ["onboarding", "team-config", organizationId],
    queryFn: async () => {
      const [tree, resources, installResult] = await Promise.all([
        getContextTreeSetting(organizationId ?? ""),
        listTeamResourcesForOrg(organizationId ?? ""),
        // Three-state result: true = installed, false = server confirmed
        // missing, null = probe failed (network blip, 5xx). The null
        // sentinel is distinct from `false` so refetchInterval below can
        // tell "we don't know yet" from "we know it's missing".
        getGithubAppInstallationExists(organizationId ?? "").catch<null>((err) => {
          console.warn("onboarding: installation-exists probe failed", err);
          return null;
        }),
      ]);
      return {
        treeUrl: tree.repo ?? "",
        teamRepoUrls: teamRecommendedRepoUrls(resources),
        // Optimistic on uncertainty: don't bounce the user into
        // no-installation on a transient blip. The refetchInterval below
        // keeps polling until we have an authoritative answer; if that
        // answer is `false` the UI will flip into no-installation on the
        // next tick. Codex round-2 review caught the original bug where
        // catch→true plus "stop polling when hasInstallation truthy"
        // wedged the query in a success state forever on the first error.
        hasInstallation: installResult !== false,
        installationKnown: installResult !== null,
      };
    },
    enabled: !!organizationId,
    // Keep polling while anything's still unknown OR the admin hasn't
    // finished. Stop only once we have a tree URL AND an authoritative
    // (non-null) install probe result. Without the `installationKnown`
    // gate, a transient error on first probe would set hasInstallation=true
    // and then stop polling — wedging the user out of the no-installation
    // safeguard for the rest of the session.
    refetchInterval: (query) => {
      const d = query.state.data;
      if (!d) return 5000;
      if (!d.treeUrl) return 5000;
      if (!d.installationKnown) return 5000;
      return false;
    },
  });

  if (teamQuery.isLoading) {
    return <StatusRow state="waiting" label="Checking what your team has set up…" />;
  }

  // Read failure → waiting; the query keeps polling so a transient blip
  // resolves on its own.
  if (teamQuery.isError || !teamQuery.data) {
    return <InviteeWaiting />;
  }

  const { treeUrl, teamRepoUrls, hasInstallation } = teamQuery.data;
  const state = resolveInviteeKickoffState({ treeUrl, hasInstallation });

  switch (state) {
    case "waiting":
      return <InviteeWaiting />;
    case "no-installation":
      return <InviteeNoInstallation />;
    case "ready":
      return <InviteeReady treeUrl={treeUrl} teamRepoUrls={teamRepoUrls} />;
  }
}

/**
 * Invitee · ready to launch. The team has a Context Tree and a GitHub
 * connection, so there's nothing left to set up — and nothing to pick: the
 * agent already inherits the team's `recommended` repo resources automatically
 * (they're enabled for every org agent). This mirrors the admin finale as a
 * pure launch. The kickoff message names the team's repos when there are any,
 * otherwise it's an intro; either way the agent enters a real chat. `orgWrites`
 * stays null — an invitee never mutates team config.
 */
function InviteeReady({ treeUrl, teamRepoUrls }: { treeUrl: string; teamRepoUrls: string[] }) {
  const { completeAndEnterChat } = useOnboardingFlow();
  const [phase, setPhase] = useState<"idle" | "starting">("idle");
  const [error, setError] = useState<string | null>(null);

  const hasRepos = teamRepoUrls.length > 0;

  const handleStart = async (): Promise<void> => {
    setError(null);
    setPhase("starting");
    try {
      // The agent already inherits the team's repos; a joining teammate's first
      // message is "read the tree to get oriented, then introduce yourself" —
      // not the admin's "reflect these repos into the tree".
      await runKickoff({
        bootstrap: buildInviteeBootstrap(treeUrl),
        orgWrites: null,
        treeMode: "existing",
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
      <StepHeading
        title={COPY.kickoff.inviteeReadyTitle}
        why={
          hasRepos
            ? COPY.kickoff.inviteeReadyWithRepos(teamRepoUrls.map(repoLabel).join(", "))
            : COPY.kickoff.inviteeReadyNoRepos
        }
      />
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
 * Shared body for the two "team isn't ready yet" sub-states: `waiting` (admin
 * hasn't created the Context Tree) and `no-installation` (tree exists but no
 * GitHub App is connected). Both are blocked on the admin and both poll +
 * advance on their own the moment the admin finishes — so the only thing the
 * invitee can DO here is not wait: meet their agent now.
 *
 * "Meet your agent" runs an intro-only kickoff (`runKickoff` with no repo → an
 * agent that introduces itself, repos connectable later from Settings), the same
 * launch the `ready` state uses. Routing it through `completeAndEnterChat` — not
 * `finishLater` — means the button lands the user in a real chat WITH the agent,
 * instead of dropping them into an empty workspace. The two states differ only
 * in copy, so they share this body; split them again if their actions diverge.
 */
function InviteeBlocked({ title, why, status }: { title: string; why: string; status: string }) {
  const { completeAndEnterChat } = useOnboardingFlow();
  const [phase, setPhase] = useState<"idle" | "starting">("idle");
  const [error, setError] = useState<string | null>(null);

  const handleMeet = async (): Promise<void> => {
    setError(null);
    setPhase("starting");
    try {
      await runKickoff({
        bootstrap: NO_REPO_BOOTSTRAP,
        orgWrites: null, // never mutate team config as an invitee
        treeMode: "existing",
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
      {/* Heading carries the screen; the pulsing StatusRow is the "still
          watching, will advance on its own" signal. */}
      <StepHeading title={title} why={why} />
      <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
        <StatusRow state="waiting" label={status} />
        {error && (
          <FlowHint tone="error" role="alert">
            {error}
          </FlowHint>
        )}
        <div className="flex">
          <Button type="button" variant="outline" onClick={() => void handleMeet()}>
            {COPY.invitee.startAnyway}
          </Button>
        </div>
      </div>
    </div>
  );
}

function InviteeWaiting() {
  return (
    <InviteeBlocked
      title={COPY.invitee.waitingTitle}
      why={COPY.invitee.waitingBody}
      status={COPY.invitee.waitingStatus}
    />
  );
}

function InviteeNoInstallation() {
  return (
    <InviteeBlocked
      title={COPY.invitee.noInstallTitle}
      why={COPY.invitee.noInstallBody}
      status={COPY.invitee.noInstallStatus}
    />
  );
}

// ── shared ──────────────────────────────────────────────────────────────

function StartingState() {
  return <WorkingState label={COPY.kickoff.starting} />;
}
