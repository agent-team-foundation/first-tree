import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { getAgentConfig, updateAgentConfig } from "../../../api/agent-config.js";
import { createAgentChat, sendChatMessage } from "../../../api/chats.js";
import { ApiError } from "../../../api/client.js";
import { listGithubRepos } from "../../../api/github.js";
import { getGithubAppInstallationExists } from "../../../api/github-app.js";
import { reportOnboardingEvent } from "../../../api/onboarding-events.js";
import {
  getContextTreeSetting,
  getSourceReposSetting,
  putContextTreeSetting,
  putSourceReposSetting,
} from "../../../api/org-settings.js";
import { Button } from "../../../components/ui/button.js";
import { buildBindBootstrap, buildCreateBootstrap } from "../../workspace/center/onboarding/bootstrap-prose.js";
import { COPY } from "../copy.js";
import { FlowNote, RepoPicker, StatusRow, StepHeading, WorkingState } from "../flow-ui.js";
import { useOnboardingFlow } from "../onboarding-flow.js";
import { resolveOnboardingAgent } from "../resolve-agent.js";
import { resolveInviteeKickoffState } from "../steps.js";

const NO_REPO_BOOTSTRAP =
  "Introduce yourself to the team — what can you help with, and what's a good first thing for me to try?";

const LINK_STYLE = {
  background: "transparent",
  border: 0,
  padding: 0,
  cursor: "pointer",
  color: "var(--accent)",
} as const;

function repoLabel(url: string): string {
  return url
    .replace(/^https?:\/\/[^/]+\//, "")
    .replace(/^git@[^:]+:/, "")
    .replace(/\.git$/, "");
}

/** Shared "create the chat + send the first task + finish" sequence. */
async function runKickoff(args: {
  bootstrap: string;
  gitRepoUrls: string[];
  orgWrites: { organizationId: string; sourceRepos: string[]; contextTreeUrl: string | null } | null;
  treeMode: "new" | "existing";
  joinPath?: "invite";
  complete: (chatId: string) => Promise<void>;
}): Promise<void> {
  const agent = await resolveOnboardingAgent();

  if (args.gitRepoUrls.length > 0) {
    const cfg = await getAgentConfig(agent.uuid);
    await updateAgentConfig(agent.uuid, {
      expectedVersion: cfg.version,
      payload: { gitRepos: args.gitRepoUrls.map((url) => ({ url })) },
    });
  }

  // Org-level writes are a convenience cache for future teammates — never
  // let them block the user's first chat.
  if (args.orgWrites) {
    if (args.orgWrites.sourceRepos.length > 0) {
      await putSourceReposSetting(args.orgWrites.organizationId, {
        repos: args.orgWrites.sourceRepos.map((url) => ({ url })),
      }).catch(() => {});
    }
    if (args.orgWrites.contextTreeUrl) {
      await putContextTreeSetting(args.orgWrites.organizationId, { repo: args.orgWrites.contextTreeUrl }).catch(
        () => {},
      );
    }
  }

  const chat = await createAgentChat(agent.uuid);
  try {
    await sendChatMessage(chat.id, args.bootstrap);
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
  } = useOnboardingFlow();
  const [phase, setPhase] = useState<"form" | "starting">("form");
  const [error, setError] = useState<string | null>(null);

  const hasRepos = selectedRepoUrls.length > 0;

  // Auto-detect an existing team Context Tree so a re-run / second admin /
  // CLI-bound tree doesn't default to creating a duplicate. retry:false so a
  // "no tree yet" miss falls through to the new-tree path fast.
  const treeSettingQuery = useQuery({
    queryKey: ["onboarding", "context-tree", organizationId],
    queryFn: () => getContextTreeSetting(organizationId ?? ""),
    enabled: !!organizationId && hasRepos,
    retry: false,
  });
  const detectedTreeUrl = treeSettingQuery.data?.repo ?? null;
  useEffect(() => {
    // One-shot: when an existing tree first arrives, default to "use existing"
    // with the URL pre-filled. After that the user can toggle freely — the
    // done-flag lives in the provider, so re-entering this step (e.g. via the
    // rail) won't re-fire and clobber a "Create new instead" choice.
    if (treeAutoInitDone || !detectedTreeUrl) return;
    markTreeAutoInitDone();
    setTreeUrl(detectedTreeUrl);
    setTreeMode("existing");
  }, [detectedTreeUrl, setTreeUrl, setTreeMode, treeAutoInitDone, markTreeAutoInitDone]);
  const autoDetected = treeMode === "existing" && !!detectedTreeUrl && treeUrl === detectedTreeUrl;

  const trimmedTreeUrl = treeUrl.trim();
  const urlInvalid = treeMode === "existing" && trimmedTreeUrl.length > 0 && !/^https:\/\//.test(trimmedTreeUrl);
  const canStart = phase === "form" && (!hasRepos || treeMode === "new" || (trimmedTreeUrl.length > 0 && !urlInvalid));

  const handleStart = async (): Promise<void> => {
    setError(null);
    setPhase("starting");
    try {
      if (!hasRepos) {
        await runKickoff({
          bootstrap: NO_REPO_BOOTSTRAP,
          gitRepoUrls: [],
          orgWrites: null,
          treeMode: "new",
          complete: completeAndEnterChat,
        });
        return;
      }
      const useExisting = treeMode === "existing";
      const bootstrap = useExisting
        ? buildBindBootstrap(selectedRepoUrls, trimmedTreeUrl)
        : buildCreateBootstrap(selectedRepoUrls);
      await runKickoff({
        bootstrap,
        gitRepoUrls: selectedRepoUrls,
        orgWrites: organizationId
          ? {
              organizationId,
              sourceRepos: selectedRepoUrls,
              contextTreeUrl: useExisting ? trimmedTreeUrl : null,
            }
          : null,
        treeMode: useExisting ? "existing" : "new",
        complete: completeAndEnterChat,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : COPY.errors.chatFailed);
      setPhase("form");
    }
  };

  if (phase === "starting") return <StartingState />;

  // C — no project connected: agent just introduces itself.
  if (!hasRepos) {
    return (
      <div className="flex flex-col" style={{ gap: "var(--sp-6)" }}>
        <StepHeading title={COPY.kickoff.noProjectTitle} />
        <div className="flex flex-col" style={{ gap: "var(--sp-5)" }}>
          <FlowNote tone="info">{COPY.kickoff.noProjectBody}</FlowNote>
          {error && <FlowNote>{error}</FlowNote>}
          <div className="flex">
            <Button type="button" onClick={() => void handleStart()} disabled={!canStart}>
              <span>{COPY.kickoff.start}</span>
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Wait for the existing-tree probe so we don't flash "new" then jump to A.
  if (treeSettingQuery.isLoading) {
    return (
      <p className="text-label" style={{ color: "var(--fg-4)" }}>
        Checking your team's setup…
      </p>
    );
  }

  const isExisting = treeMode === "existing";
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-6)" }}>
      <StepHeading
        title={isExisting ? COPY.kickoff.existingTitle : COPY.kickoff.newTitle}
        why={isExisting ? COPY.kickoff.existingWhy : COPY.kickoff.newWhy}
      />
      <div className="flex flex-col" style={{ gap: "var(--sp-5)" }}>
        {isExisting ? (
          // A (auto-detected, pre-filled) or B′ (manually "I already have one").
          <div className="flex flex-col" style={{ gap: "var(--sp-1_5)" }}>
            <label htmlFor="onboarding-tree-url" className="text-label" style={{ color: "var(--fg-3)" }}>
              {COPY.kickoff.existingUrlLabel}
            </label>
            <input
              id="onboarding-tree-url"
              value={treeUrl}
              onChange={(e) => setTreeUrl(e.target.value)}
              placeholder="https://github.com/your-team/context-tree"
              className="text-body mono"
              style={{
                padding: "var(--sp-2) var(--sp-3)",
                background: "var(--bg)",
                border: "var(--hairline) solid var(--border)",
                borderRadius: "var(--radius-input)",
                color: "var(--fg)",
                outline: "none",
              }}
            />
            {autoDetected ? (
              <p className="text-label" style={{ margin: 0, color: "var(--fg-4)" }}>
                {COPY.kickoff.autoDetectedNote}
              </p>
            ) : null}
            {urlInvalid && <FlowNote>{COPY.kickoff.invalidUrl}</FlowNote>}
            <button
              type="button"
              onClick={() => {
                setTreeUrl("");
                setTreeMode("new");
              }}
              className="text-label self-start"
              style={LINK_STYLE}
            >
              {COPY.kickoff.createInstead}
            </button>
          </div>
        ) : (
          // B (new tree, default): quiet secondary link to the existing path.
          <button
            type="button"
            onClick={() => setTreeMode("existing")}
            className="text-label self-start"
            style={LINK_STYLE}
          >
            {COPY.kickoff.haveExisting}
          </button>
        )}
        {error && <FlowNote>{error}</FlowNote>}
        <div className="flex">
          <Button type="button" onClick={() => void handleStart()} disabled={!canStart}>
            <span>{COPY.kickoff.start}</span>
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
  // Fetch tree config, source repos, and installation existence together.
  // The installation bit drives the new "no-installation" sub-state, which
  // catches "admin set up the tree but never connected GitHub" before the
  // invitee sails into the picker and hits a 403 on the first git op.
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
      const [tree, repos, exists] = await Promise.all([
        getContextTreeSetting(organizationId ?? ""),
        getSourceReposSetting(organizationId ?? ""),
        getGithubAppInstallationExists(organizationId ?? "").catch((err) => {
          // Conservative on unknown error: stay on the happy path. The
          // 5-second poll below re-checks, and if the install truly is
          // missing the next tick will catch it.
          console.warn("onboarding: installation-exists probe failed", err);
          return true;
        }),
      ]);
      return {
        treeUrl: tree.repo ?? "",
        teamRepoUrls: (repos.repos ?? []).map((r) => r.url),
        hasInstallation: exists,
      };
    },
    enabled: !!organizationId,
    // While anything's still missing on the team side, keep polling so the
    // invitee advances on its own the moment the admin catches up — no
    // manual refresh. Stop once tree + installation are both present.
    refetchInterval: (query) => {
      const d = query.state.data;
      if (d?.treeUrl && d?.hasInstallation) return false;
      return 5000;
    },
  });

  if (teamQuery.isLoading) {
    return (
      <p className="text-label" style={{ color: "var(--fg-4)" }}>
        Checking what your team has set up…
      </p>
    );
  }

  // Read failure → waiting; the query keeps polling so a transient blip
  // resolves on its own.
  if (teamQuery.isError || !teamQuery.data) {
    return <InviteeWaiting />;
  }

  const { treeUrl, teamRepoUrls, hasInstallation } = teamQuery.data;
  const state = resolveInviteeKickoffState({
    treeUrl,
    hasInstallation,
    teamRepoCount: teamRepoUrls.length,
  });

  switch (state) {
    case "waiting":
      return <InviteeWaiting />;
    case "no-installation":
      return <InviteeNoInstallation />;
    case "confirm":
      return <InviteeConfirm treeUrl={treeUrl} teamRepoUrls={teamRepoUrls} />;
    case "picker":
      return <InviteePicker treeUrl={treeUrl} />;
  }
}

/**
 * Read-only display of the team's Context Tree URL, shown at the top of
 * the invitee's confirm/picker sub-states so they know where their agent's
 * work will land. Info transparency — invitee inherits this, can't change it.
 */
function TreeUrlDisplay({ treeUrl }: { treeUrl: string }) {
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-0_5)" }}>
      <p className="text-label" style={{ margin: 0, color: "var(--fg-4)" }}>
        {COPY.kickoff.treeLabel}
      </p>
      <p
        className="text-label mono"
        title={treeUrl}
        style={{
          margin: 0,
          color: "var(--fg-2)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {repoLabel(treeUrl)}
      </p>
    </div>
  );
}

function InviteeConfirm({ treeUrl, teamRepoUrls }: { treeUrl: string; teamRepoUrls: string[] }) {
  const { completeAndEnterChat } = useOnboardingFlow();
  const [chosen, setChosen] = useState<string[]>(teamRepoUrls);
  const [phase, setPhase] = useState<"form" | "starting">("form");
  const [error, setError] = useState<string | null>(null);

  const toggle = (url: string): void =>
    setChosen((prev) => (prev.includes(url) ? prev.filter((u) => u !== url) : [...prev, url]));

  const handleStart = async (selectedRepos: string[]): Promise<void> => {
    setError(null);
    setPhase("starting");
    try {
      // Empty selection ⇒ intro-only bootstrap (matches admin's no-project
      // path), so deselecting all isn't a dead end.
      const bootstrap = selectedRepos.length > 0 ? buildBindBootstrap(selectedRepos, treeUrl) : NO_REPO_BOOTSTRAP;
      await runKickoff({
        bootstrap,
        gitRepoUrls: selectedRepos,
        orgWrites: null, // never mutate team config as an invitee
        treeMode: "existing",
        joinPath: "invite",
        complete: completeAndEnterChat,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : COPY.errors.chatFailed);
      setPhase("form");
    }
  };

  if (phase === "starting") return <StartingState />;

  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-6)" }}>
      <StepHeading title={COPY.invitee.confirmTitle} why={COPY.invitee.confirmBody} />
      <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
        <TreeUrlDisplay treeUrl={treeUrl} />
        <div className="flex flex-col" style={{ gap: "var(--sp-1)" }}>
          {teamRepoUrls.map((url) => {
            const active = chosen.includes(url);
            return (
              <label
                key={url}
                className="onboarding-choice flex items-center text-body"
                style={{
                  gap: "var(--sp-2_5)",
                  padding: "var(--sp-2) var(--sp-2_5)",
                  borderRadius: "var(--radius-input)",
                  cursor: "pointer",
                  background: active ? "color-mix(in oklch, var(--accent) 8%, transparent)" : "transparent",
                  color: active ? "var(--fg)" : "var(--fg-2)",
                }}
              >
                <input type="checkbox" checked={active} onChange={() => toggle(url)} className="sr-only" />
                <span
                  aria-hidden="true"
                  className="inline-flex items-center justify-center"
                  style={{
                    width: "var(--sp-4)",
                    height: "var(--sp-4)",
                    flexShrink: 0,
                    borderRadius: "var(--radius-input)",
                    border: active
                      ? "var(--hairline) solid var(--accent)"
                      : "var(--hairline) solid var(--border-strong)",
                    background: active ? "var(--accent)" : "transparent",
                    color: "var(--bg)",
                  }}
                >
                  {active && <Check className="h-3 w-3" />}
                </span>
                <span className="font-medium">{repoLabel(url)}</span>
              </label>
            );
          })}
        </div>
        {error && <FlowNote>{error}</FlowNote>}
        {/* Primary is never disabled by deselect-all; the bailout link
            preserves the "continue with intro only" path so users can't
            soft-lock themselves. */}
        <div className="flex items-center" style={{ gap: "var(--sp-4)", flexWrap: "wrap" }}>
          <Button type="button" onClick={() => void handleStart(chosen)} disabled={chosen.length === 0}>
            <span>{COPY.kickoff.start}</span>
            <ArrowRight className="h-4 w-4" />
          </Button>
          <button
            type="button"
            onClick={() => void handleStart([])}
            className="text-label"
            style={{ background: "transparent", border: 0, padding: 0, cursor: "pointer", color: "var(--fg-4)" }}
          >
            {COPY.kickoff.inviteeContinueNoProject}
          </button>
        </div>
      </div>
    </div>
  );
}

function InviteePicker({ treeUrl }: { treeUrl: string }) {
  const { completeAndEnterChat } = useOnboardingFlow();
  const [selected, setSelected] = useState<string[]>([]);
  const [phase, setPhase] = useState<"form" | "starting">("form");
  const [error, setError] = useState<string | null>(null);
  const reposQuery = useQuery({ queryKey: ["onboarding", "github-repos"], queryFn: listGithubRepos });

  const toggle = (url: string): void =>
    setSelected((prev) => (prev.includes(url) ? prev.filter((u) => u !== url) : [...prev, url]));

  const handleStart = async (selectedRepos: string[]): Promise<void> => {
    setError(null);
    setPhase("starting");
    try {
      const bootstrap = selectedRepos.length > 0 ? buildBindBootstrap(selectedRepos, treeUrl) : NO_REPO_BOOTSTRAP;
      await runKickoff({
        bootstrap,
        gitRepoUrls: selectedRepos,
        orgWrites: null,
        treeMode: "existing",
        joinPath: "invite",
        complete: completeAndEnterChat,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : COPY.errors.chatFailed);
      setPhase("form");
    }
  };

  if (phase === "starting") return <StartingState />;

  // Three failure shapes are folded into one "no list" branch in the
  // legacy code; split them so the recovery action matches the cause.
  const scopeMissing = reposQuery.error instanceof ApiError && reposQuery.error.status === 403;
  const networkErr = !!reposQuery.error && !scopeMissing;
  const empty = !reposQuery.error && (reposQuery.data?.length ?? 0) === 0;
  const hasRepos = !reposQuery.error && (reposQuery.data?.length ?? 0) > 0;

  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-6)" }}>
      <StepHeading title={COPY.kickoff.inviteePickerTitle} why={COPY.kickoff.inviteePickerWhy} />
      <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
        <TreeUrlDisplay treeUrl={treeUrl} />
        {reposQuery.isLoading ? (
          <p className="text-label" style={{ color: "var(--fg-4)" }}>
            Loading your projects…
          </p>
        ) : scopeMissing ? (
          <FlowNote tone="info">
            <a
              href="/api/v1/auth/github/start?next=/onboarding"
              className="font-medium"
              style={{ color: "var(--accent)" }}
            >
              {COPY.connectCode.reconnect}
            </a>
          </FlowNote>
        ) : networkErr ? (
          <FlowNote>{COPY.kickoff.inviteePickerNetworkError}</FlowNote>
        ) : empty ? (
          <FlowNote tone="info">{COPY.kickoff.inviteePickerEmpty}</FlowNote>
        ) : (
          <RepoPicker repos={reposQuery.data ?? []} selected={selected} onToggle={toggle} fill />
        )}
        {error && <FlowNote>{error}</FlowNote>}
        <div className="flex items-center" style={{ gap: "var(--sp-4)", flexWrap: "wrap" }}>
          <Button
            type="button"
            onClick={() => void handleStart(selected)}
            disabled={!hasRepos || selected.length === 0}
          >
            <span>{COPY.kickoff.start}</span>
            <ArrowRight className="h-4 w-4" />
          </Button>
          {/* Always visible — covers empty, scope-missing, network, AND
              "I just don't want to pick one right now". No path is a
              dead end. */}
          <button
            type="button"
            onClick={() => void handleStart([])}
            className="text-label"
            style={{ background: "transparent", border: 0, padding: 0, cursor: "pointer", color: "var(--fg-4)" }}
          >
            {COPY.kickoff.inviteeContinueNoProject}
          </button>
        </div>
      </div>
    </div>
  );
}

function InviteeWaiting() {
  const { finishLater } = useOnboardingFlow();
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-6)" }}>
      <StepHeading title={COPY.invitee.waitingTitle} />
      <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
        <FlowNote tone="info">{COPY.invitee.waitingBody}</FlowNote>
        {/* Visible polling so the user trusts the page is alive — the
            previous "no status" state had users wondering if it was
            stuck. */}
        <StatusRow state="waiting" label={COPY.invitee.waitingStatus} />
        <div className="flex">
          <Button type="button" variant="outline" onClick={() => void finishLater()}>
            {COPY.invitee.startAnyway}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * NEW sub-state: admin set a tree URL but never connected the GitHub App,
 * so the org has no installation row. Without one, the agent's first git
 * operation will 403 with no useful signal. We surface that here and offer
 * a "remind your admin" copy-link + a bailout to keep the user moving.
 *
 * Why this link IS safe to share (unlike connect-code's install URL): we
 * copy `window.location.href`, the onboarding page URL itself, with no
 * cookie-bound state JWT. Whoever opens it just lands on first-tree as
 * themselves; if they're the admin, they see their own onboarding /
 * Settings → GitHub and can finish the install. It's a reminder URL, not
 * an authorization handoff.
 */
function InviteeNoInstallation() {
  const { finishLater } = useOnboardingFlow();
  const [pageUrl, setPageUrl] = useState<string>("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined") setPageUrl(window.location.href);
  }, []);

  const handleCopy = async (): Promise<void> => {
    if (!pageUrl) return;
    await navigator.clipboard.writeText(pageUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-6)" }}>
      <StepHeading title={COPY.invitee.noInstallTitle} />
      <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
        <FlowNote tone="info">{COPY.invitee.noInstallBody}</FlowNote>
        <StatusRow state="waiting" label={COPY.invitee.noInstallStatus} />

        <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
          <p className="text-label" style={{ margin: 0, color: "var(--fg-2)" }}>
            {COPY.invitee.noInstallShareIntro}
          </p>
          <div className="flex" style={{ gap: "var(--sp-2)", alignItems: "stretch" }}>
            <div
              className="text-label"
              title={pageUrl}
              style={{
                flex: 1,
                minHeight: 38,
                padding: "var(--sp-2_5) var(--sp-3)",
                background: "color-mix(in oklch, var(--bg-sunken) 42%, transparent)",
                border: "var(--hairline) solid color-mix(in oklch, var(--border-faint) 58%, transparent)",
                borderRadius: "var(--radius-input)",
                color: "var(--fg-2)",
                minWidth: 0,
                display: "flex",
                alignItems: "center",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {pageUrl || "…"}
            </div>
            <button
              type="button"
              onClick={() => void handleCopy()}
              disabled={!pageUrl}
              className="inline-flex items-center justify-center text-label font-medium"
              style={{
                gap: "var(--sp-1_5)",
                padding: "0 var(--sp-3)",
                minHeight: 38,
                background: "color-mix(in oklch, var(--bg-raised) 48%, transparent)",
                border: "var(--hairline) solid color-mix(in oklch, var(--border) 58%, transparent)",
                borderRadius: "var(--radius-input)",
                color: "var(--fg-2)",
                cursor: pageUrl ? "pointer" : "not-allowed",
                opacity: pageUrl ? 1 : 0.6,
              }}
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>

        <div className="flex">
          <Button type="button" variant="outline" onClick={() => void finishLater()}>
            {COPY.invitee.startAnyway}
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
