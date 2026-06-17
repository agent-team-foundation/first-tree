import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { createAgentChat, sendChatMessage } from "../../../api/chats.js";
import { listOrgGithubRepos } from "../../../api/github.js";
import { getGithubAppInstallationExists } from "../../../api/github-app.js";
import { reportOnboardingEvent } from "../../../api/onboarding-events.js";
import { getContextTreeSetting, putContextTreeSetting } from "../../../api/org-settings.js";
import { createTeamResourceForOrg } from "../../../api/resources.js";
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

/** Shared "create the chat + send the first task + finish" sequence. */
async function runKickoff(args: {
  bootstrap: string;
  orgWrites: { organizationId: string; sourceRepos: string[]; contextTreeUrl: string | null } | null;
  treeMode: "new" | "existing";
  /** The selected org — scopes agent resolution so the seed never lands on an
   *  agent from a different org (notably the build-tree recovery surface). */
  organizationId: string | null;
  joinPath?: "invite";
  complete: (chatId: string) => Promise<void>;
}): Promise<void> {
  const agent = await resolveOnboardingAgent(args.organizationId);

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
  const queryClient = useQueryClient();
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
          organizationId,
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
      // (`createTeamResourceForOrg` only validates URL shape; existing-tree
      // writes are best-effort). So surface a retryable error instead of
      // registering a possibly-stale selection — clicking Start again retries.
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
          bootstrap: NO_REPO_BOOTSTRAP,
          orgWrites: null,
          treeMode: "new",
          organizationId,
          complete: completeAndEnterChat,
        });
        return;
      }

      const useExisting = treeMode === "existing";
      const detectedUrl = treeUrl.trim();
      const bootstrap = useExisting ? buildBindBootstrap(repos, detectedUrl) : buildCreateBootstrap(repos);
      await runKickoff({
        bootstrap,
        orgWrites: organizationId
          ? {
              organizationId,
              sourceRepos: repos,
              contextTreeUrl: useExisting ? detectedUrl : null,
            }
          : null,
        treeMode: useExisting ? "existing" : "new",
        organizationId,
        complete: completeAndEnterChat,
      });
      // The kickoff just provisioned/confirmed the team's tree binding
      // server-side. Drop the cached org `context_tree` setting so the recovery
      // gate (useNeedsTreeSetup) and the Settings/Context surfaces read the
      // fresh binding on next mount instead of re-offering "build your tree" for
      // a tree that now exists. (`removeQueries`, not `invalidate`, so a stale
      // value can't flash before the refetch resolves.)
      if (organizationId) {
        queryClient.removeQueries({ queryKey: ["org-setting", organizationId, "context_tree"] });
      }
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

  // Wait for the existing-tree probe so we don't flash "new" then flip to "read".
  if (treeSettingQuery.isLoading) {
    return <StatusRow state="waiting" label="Checking your team's setup…" />;
  }

  const isExisting = treeMode === "existing";
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-6)" }}>
      {/* Recovery suppresses the per-step heading — its shell supplies the
          constant "Build your team's Context Tree" title. */}
      <StepHeading
        title={recovery ? "" : isExisting ? COPY.kickoff.existingTitle : COPY.kickoff.newTitle}
        why={isExisting ? COPY.kickoff.existingWhy(repoCount) : COPY.kickoff.newWhy(repoCount)}
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
 * pure launch into a real chat. `orgWrites` stays null — an invitee never
 * mutates team config.
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
      // message is "read the tree to get oriented, then introduce yourself" —
      // not the admin's "reflect these repos into the tree".
      await runKickoff({
        bootstrap: buildInviteeBootstrap(treeUrl),
        orgWrites: null,
        treeMode: "existing",
        organizationId,
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
        bootstrap: NO_REPO_BOOTSTRAP,
        orgWrites: null, // never mutate team config as an invitee
        treeMode: "existing",
        organizationId,
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
            so the real path forward is to start now. The auto-advance — if the
            team does finish — is the quiet status footnote below, never the
            headline. */}
        <div className="flex">
          <Button type="button" variant="cta" onClick={() => void handleMeet()}>
            <span>{COPY.invitee.startAnyway}</span>
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
        <StatusRow state="waiting" label={COPY.invitee.notReadyStatus} />
      </div>
    </div>
  );
}

// ── shared ──────────────────────────────────────────────────────────────

function StartingState() {
  return <WorkingState label={COPY.kickoff.starting} />;
}
