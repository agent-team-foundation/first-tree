import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { useState } from "react";
import { getAgentConfig, updateAgentConfig } from "../../../api/agent-config.js";
import { createAgentChat, sendChatMessage } from "../../../api/chats.js";
import { listGithubRepos } from "../../../api/github.js";
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
import { FlowNote, RepoPicker, StatusRow } from "../flow-ui.js";
import { useOnboardingFlow } from "../onboarding-flow.js";
import { resolveOnboardingAgent } from "../resolve-agent.js";

const NO_REPO_BOOTSTRAP =
  "Introduce yourself to the team — what can you help with, and what's a good first thing for me to try?";

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
  } catch {
    // Non-fatal: the chat exists; the agent introduces itself when the
    // user types.
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
  const { organizationId, selectedRepoUrls, treeMode, setTreeMode, treeUrl, setTreeUrl, completeAndEnterChat } =
    useOnboardingFlow();
  const [phase, setPhase] = useState<"form" | "starting">("form");
  const [error, setError] = useState<string | null>(null);

  const hasRepos = selectedRepoUrls.length > 0;
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

  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-5)" }}>
      {hasRepos ? (
        <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
          <p className="text-label font-medium" style={{ margin: 0, color: "var(--fg-2)" }}>
            {COPY.kickoff.existingTitle}
          </p>
          <ModeCard
            active={treeMode === "new"}
            title={COPY.kickoff.createOption}
            hint={COPY.kickoff.createHint}
            onSelect={() => setTreeMode("new")}
          />
          <ModeCard
            active={treeMode === "existing"}
            title={COPY.kickoff.existingOption}
            hint={COPY.kickoff.existingHint}
            onSelect={() => setTreeMode("existing")}
          />
          {treeMode === "existing" && (
            <div className="flex flex-col" style={{ gap: "var(--sp-1_5)", marginTop: "var(--sp-1)" }}>
              <label htmlFor="onboarding-tree-url" className="text-label" style={{ color: "var(--fg-3)" }}>
                {COPY.kickoff.existingUrlLabel}
              </label>
              <input
                id="onboarding-tree-url"
                value={treeUrl}
                onChange={(e) => setTreeUrl(e.target.value)}
                placeholder="https://github.com/your-team/knowledge"
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
              {urlInvalid && <FlowNote>{COPY.kickoff.invalidUrl}</FlowNote>}
            </div>
          )}
          <p className="text-label" style={{ margin: "var(--sp-1) 0 0", color: "var(--fg-4)" }}>
            Working on: {selectedRepoUrls.map(repoLabel).join(", ")}
          </p>
        </div>
      ) : (
        <FlowNote tone="info">
          No project is connected, so your AI teammate will start with a quick intro. You can connect a project later
          from Settings to give it real context.
        </FlowNote>
      )}

      {error && <FlowNote>{error}</FlowNote>}

      <div className="flex">
        <Button type="button" onClick={() => void handleStart()} disabled={!canStart}>
          <span>{COPY.kickoff.start}</span>
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

// ── Invitee ─────────────────────────────────────────────────────────────

function InviteeKickoff() {
  const { organizationId } = useOnboardingFlow();
  const teamQuery = useQuery({
    queryKey: ["onboarding", "team-config", organizationId],
    queryFn: async () => {
      const [tree, repos] = await Promise.all([
        getContextTreeSetting(organizationId ?? ""),
        getSourceReposSetting(organizationId ?? ""),
      ]);
      return { treeUrl: tree.repo ?? "", teamRepoUrls: (repos.repos ?? []).map((r) => r.url) };
    },
    enabled: !!organizationId,
  });

  if (teamQuery.isLoading) {
    return (
      <p className="text-label" style={{ color: "var(--fg-4)" }}>
        Checking what your team has set up…
      </p>
    );
  }

  // Read failure or no tree configured yet → waiting state.
  if (teamQuery.isError || !teamQuery.data?.treeUrl) {
    return <InviteeWaiting />;
  }

  const { treeUrl, teamRepoUrls } = teamQuery.data;
  return teamRepoUrls.length > 0 ? (
    <InviteeConfirm treeUrl={treeUrl} teamRepoUrls={teamRepoUrls} />
  ) : (
    <InviteePicker treeUrl={treeUrl} />
  );
}

function InviteeConfirm({ treeUrl, teamRepoUrls }: { treeUrl: string; teamRepoUrls: string[] }) {
  const { completeAndEnterChat } = useOnboardingFlow();
  const [chosen, setChosen] = useState<string[]>(teamRepoUrls);
  const [phase, setPhase] = useState<"form" | "starting">("form");
  const [error, setError] = useState<string | null>(null);

  const toggle = (url: string): void =>
    setChosen((prev) => (prev.includes(url) ? prev.filter((u) => u !== url) : [...prev, url]));

  const handleStart = async (): Promise<void> => {
    setError(null);
    setPhase("starting");
    try {
      await runKickoff({
        bootstrap: buildBindBootstrap(chosen, treeUrl),
        gitRepoUrls: chosen,
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
    <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
      <FlowNote tone="info">{COPY.invitee.confirmBody}</FlowNote>
      <div className="flex flex-col" style={{ gap: "var(--sp-1)" }}>
        {teamRepoUrls.map((url) => {
          const active = chosen.includes(url);
          return (
            <label
              key={url}
              className="flex items-center text-body"
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
                  border: active ? "var(--hairline) solid var(--accent)" : "var(--hairline) solid var(--border-strong)",
                  background: active ? "var(--accent)" : "transparent",
                }}
              />
              <span className="font-medium">{repoLabel(url)}</span>
            </label>
          );
        })}
      </div>
      {error && <FlowNote>{error}</FlowNote>}
      <div className="flex">
        <Button type="button" onClick={() => void handleStart()} disabled={chosen.length === 0}>
          <span>{COPY.kickoff.start}</span>
          <ArrowRight className="h-4 w-4" />
        </Button>
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

  const handleStart = async (): Promise<void> => {
    setError(null);
    setPhase("starting");
    try {
      await runKickoff({
        bootstrap: buildBindBootstrap(selected, treeUrl),
        gitRepoUrls: selected,
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

  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
      <FlowNote tone="info">Your team's knowledge base is ready. Pick the project you'll work on.</FlowNote>
      {reposQuery.isLoading ? (
        <p className="text-label" style={{ color: "var(--fg-4)" }}>
          Loading your projects…
        </p>
      ) : (reposQuery.data?.length ?? 0) === 0 ? (
        <FlowNote tone="info">{COPY.connectCode.noRepos}</FlowNote>
      ) : (
        <RepoPicker repos={reposQuery.data ?? []} selected={selected} onToggle={toggle} />
      )}
      {error && <FlowNote>{error}</FlowNote>}
      <div className="flex">
        <Button type="button" onClick={() => void handleStart()} disabled={selected.length === 0}>
          <span>{COPY.kickoff.start}</span>
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function InviteeWaiting() {
  const { finishLater } = useOnboardingFlow();
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
      <p className="text-subtitle font-semibold" style={{ margin: 0, color: "var(--fg)" }}>
        {COPY.invitee.waitingTitle}
      </p>
      <FlowNote tone="info">{COPY.invitee.waitingBody}</FlowNote>
      <div className="flex">
        <Button type="button" variant="outline" onClick={() => void finishLater()}>
          Start chatting anyway
        </Button>
      </div>
    </div>
  );
}

// ── shared ──────────────────────────────────────────────────────────────

function ModeCard({
  active,
  title,
  hint,
  onSelect,
}: {
  active: boolean;
  title: string;
  hint: string;
  onSelect: () => void;
}) {
  return (
    <label
      className="flex items-start text-body"
      style={{
        gap: "var(--sp-2)",
        padding: "var(--sp-2) var(--sp-3)",
        background: active ? "color-mix(in oklch, var(--accent) 8%, var(--bg))" : "var(--bg)",
        border: active ? "var(--hairline) solid var(--accent)" : "var(--hairline) solid var(--border-faint)",
        borderRadius: "var(--radius-input)",
        cursor: "pointer",
      }}
    >
      <input type="radio" name="onboarding-tree-mode" checked={active} onChange={onSelect} className="sr-only" />
      <span
        aria-hidden="true"
        className="inline-flex items-center justify-center"
        style={{
          width: "var(--sp-3_5)",
          height: "var(--sp-3_5)",
          marginTop: "var(--sp-0_5)",
          flexShrink: 0,
          borderRadius: "50%",
          border: active ? "var(--hairline) solid var(--accent)" : "var(--hairline) solid var(--border-strong)",
        }}
      >
        {active && (
          <span
            style={{
              width: "var(--sp-1_5)",
              height: "var(--sp-1_5)",
              borderRadius: "50%",
              background: "var(--accent)",
            }}
          />
        )}
      </span>
      <span className="flex flex-col" style={{ gap: "var(--sp-0_5)", minWidth: 0 }}>
        <span className="font-medium" style={{ color: active ? "var(--fg)" : "var(--fg-2)" }}>
          {title}
        </span>
        <span className="text-label" style={{ color: "var(--fg-3)" }}>
          {hint}
        </span>
      </span>
    </label>
  );
}

function StartingState() {
  return (
    <div className="flex flex-col items-center text-center" style={{ paddingTop: "var(--sp-8)", gap: "var(--sp-3)" }}>
      <StatusRow state="waiting" label={COPY.kickoff.starting} />
    </div>
  );
}
