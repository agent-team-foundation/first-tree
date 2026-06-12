import {
  type AgentChatStatus,
  isWorkspaceHealthDegraded,
  WORKSPACE_FIX_CHAT_PURPOSE,
  type WorkspaceHealth,
} from "@first-tree/shared";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { chatAgentStatusQueryKey, fetchChatAgentStatuses } from "../api/agent-status.js";
import { getChat, sendChatMessage } from "../api/chats.js";
import { createMeChat } from "../api/me-chats.js";
import { formatRelative } from "../lib/utils.js";
import {
  buildWorkspaceFixMessage,
  buildWorkspaceFixTopic,
  workspaceHealthReasonLabel,
} from "../lib/workspace-fix-template.js";
import { Popover } from "./ui/popover.js";

/**
 * Topbar warning chip for the *selected chat's* agents whose workspace is
 * degraded (source repos / Context Tree unreachable at session start — design:
 * docs/degraded-workspace-design.md §3.1/§3.2). Sits right beside
 * `DisconnectChip` and borrows its visual form, but in the shared caution hue
 * (`--state-blocked`) rather than error red: the agent is up and answering,
 * it just can't see some team code.
 *
 * Yield rule: an agent whose client is disconnected is excluded
 * (`!s.reachable`) — that situation is owned by DisconnectChip, and a stale
 * health report would only double-bill the same outage. Renders nothing
 * when no selected chat / nothing degraded, so the topbar stays clean.
 */
export function DegradedWorkspaceChip() {
  const [searchParams] = useSearchParams();
  const chatId = searchParams.get("c");
  // `draft` is the new-chat composer sentinel, not a real chat id.
  const validChatId = chatId && chatId !== "draft" ? chatId : null;

  const { data: statuses } = useQuery({
    queryKey: chatAgentStatusQueryKey(validChatId ?? ""),
    queryFn: () => fetchChatAgentStatuses(validChatId ?? ""),
    enabled: validChatId !== null,
    // Same cadence as the chat surfaces; freshness mostly rides the admin-WS
    // push (use-admin-ws upserts this exact query key).
    refetchInterval: 30_000,
  });

  const { data: chatDetail } = useQuery({
    queryKey: ["chat-detail", validChatId],
    queryFn: () => getChat(validChatId ?? ""),
    enabled: validChatId !== null,
  });

  const degraded = (statuses ?? []).filter(
    (s): s is AgentChatStatus & { workspaceHealth: WorkspaceHealth } =>
      s.reachable && s.workspaceHealth != null && isWorkspaceHealthDegraded(s.workspaceHealth),
  );
  if (validChatId === null || degraded.length === 0) return null;

  const nameOf = (agentId: string): string => {
    const p = chatDetail?.participants.find((row) => row.agentId === agentId);
    return p?.displayName ?? p?.name ?? agentId.slice(0, 8);
  };

  const label = chipLabel(degraded, nameOf);
  const tooltip = `${label}. Click for details.`;

  return (
    <Popover
      align="start"
      offset={6}
      panelStyle={{ width: 380, maxWidth: "calc(100vw - var(--sp-6))", maxHeight: "70vh", overflowY: "auto" }}
      trigger={({ toggle }) => (
        <button
          type="button"
          onClick={toggle}
          title={tooltip}
          aria-label={tooltip}
          className="inline-flex items-center cursor-pointer text-body font-medium"
          style={{
            gap: 8,
            height: 26,
            padding: "0 var(--sp-2_5) 0 var(--sp-2_25)",
            borderRadius: 999,
            border: 0,
            outline: "var(--hairline) solid color-mix(in oklch, var(--state-blocked) 38%, transparent)",
            outlineOffset: -1,
            background: "var(--state-blocked-soft)",
            color: "color-mix(in oklch, var(--state-blocked) 80%, var(--fg))",
            minWidth: 0,
          }}
        >
          <AmberDot />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
        </button>
      )}
    >
      {({ close }) => (
        <div style={{ padding: "var(--sp-3)", display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
          {degraded.map((s) => (
            <DegradedAgentSection
              key={s.agentId}
              status={s}
              health={s.workspaceHealth}
              name={nameOf(s.agentId)}
              close={close}
            />
          ))}
        </div>
      )}
    </Popover>
  );
}

/** Entry counts behind the chip label / popover summary line. */
function healthCounts(health: WorkspaceHealth): {
  degradedCount: number;
  total: number;
  anyUnreachable: boolean;
} {
  const badRepos = health.repos.filter((r) => r.status !== "ok");
  const treeBad = health.tree.status === "stale" || health.tree.status === "unreachable";
  // The tree only counts toward the total when this agent has one bound at
  // all — otherwise "all N repos" would never be reachable for tree-less
  // agents.
  const total = health.repos.length + (health.tree.status === "unbound" ? 0 : 1);
  return {
    degradedCount: badRepos.length + (treeBad ? 1 : 0),
    total,
    anyUnreachable: badRepos.some((r) => r.status === "unreachable") || health.tree.status === "unreachable",
  };
}

function chipLabel(degraded: AgentChatStatus[], nameOf: (agentId: string) => string): string {
  if (degraded.length > 1) return `${degraded.length} agents · workspace degraded`;
  const s = degraded[0];
  if (!s?.workspaceHealth) return "workspace degraded";
  const { degradedCount, total, anyUnreachable } = healthCounts(s.workspaceHealth);
  // "stale" only when nothing is outright unreachable (frozen mirrors still
  // exist locally — softer wording for a softer failure).
  const word = anyUnreachable ? "unreachable" : "stale";
  const countText =
    degradedCount === total && total > 1
      ? `all ${total} repos ${word}`
      : `${degradedCount} ${degradedCount === 1 ? "repo" : "repos"} ${word}`;
  return `${nameOf(s.agentId)} · ${countText}`;
}

/** One agent's block in the popover: degraded rows + guidance + Fix button. */
function DegradedAgentSection({
  status,
  health,
  name,
  close,
}: {
  status: AgentChatStatus;
  health: WorkspaceHealth;
  name: string;
  close: () => void;
}) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const hostname = status.clientHostname ?? "this machine";
  const badRepos = health.repos.filter(
    (r): r is (typeof health.repos)[number] & { status: "stale" | "unreachable" } => r.status !== "ok",
  );
  const treeBad = health.tree.status === "stale" || health.tree.status === "unreachable";
  const has404 = badRepos.some((r) => r.reasonCode === "git_repo_not_found");

  const onFix = async (): Promise<void> => {
    setBusy(true);
    try {
      // Dedup lives server-side on (purpose, agentId): a second click — or a
      // teammate's earlier click — lands in the same fix chat, and `reused`
      // tells us not to re-send the kickoff template.
      const res = await createMeChat({
        participantIds: [status.agentId],
        topic: buildWorkspaceFixTopic(hostname),
        purpose: { kind: WORKSPACE_FIX_CHAT_PURPOSE, agentId: status.agentId },
      });
      if (!res.reused) {
        await sendChatMessage(res.chatId, buildWorkspaceFixMessage({ health, hostname, locale: navigator.language }), [
          status.agentId,
        ]);
      }
      close();
      navigate(`/?c=${encodeURIComponent(res.chatId)}`);
    } catch (err) {
      console.error("[degraded-workspace] failed to open fix chat", err);
      setBusy(false);
    }
  };

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
      <div className="flex items-center" style={{ gap: 8, minWidth: 0 }}>
        <span className="text-body font-semibold" style={{ color: "var(--fg)" }}>
          {name}
        </span>
        <span className="text-label" style={{ color: "var(--fg-3)", whiteSpace: "nowrap" }}>
          reported {formatRelative(health.updatedAt)}
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-1_5)" }}>
        {badRepos.map((repo) => (
          <DegradedRow
            key={repo.url}
            url={repo.url}
            status={repo.status}
            reason={workspaceHealthReasonLabel(repo.reasonCode, false)}
            headCommit={repo.headCommit}
          />
        ))}
        {treeBad && health.tree.repoUrl ? (
          <DegradedRow
            url={health.tree.repoUrl}
            status={health.tree.status === "unreachable" ? "unreachable" : "stale"}
            reason={workspaceHealthReasonLabel(health.tree.reasonCode, false)}
            tag="Context Tree"
          />
        ) : null}
      </div>

      <div className="text-label" style={{ color: "var(--fg-3)", display: "flex", flexDirection: "column", gap: 4 }}>
        {has404 ? (
          <span>
            "not found (404)" can mean the repo was deleted/renamed <em>or</em> that the credentials on{" "}
            <span className="mono">{hostname}</span> lack access — GitHub hides private repos it won't authorize.
          </span>
        ) : null}
        <span>
          1. Confirm the GitHub account used on <span className="mono">{hostname}</span> has access to the repos above
          (a team admin can check).
        </span>
        <span>
          2. Fix credentials on <span className="mono">{hostname}</span> — <span className="mono">gh auth login</span>,
          an SSH key, or a git credential helper — then test with{" "}
          <span className="mono">git ls-remote &lt;url&gt;</span>.
        </span>
        <span>3. The warning clears automatically when the agent's next session starts.</span>
      </div>

      <div>
        <button
          type="button"
          onClick={() => void onFix()}
          disabled={busy}
          className="inline-flex items-center cursor-pointer text-body font-medium"
          style={{
            gap: 6,
            height: 26,
            padding: "0 var(--sp-2_5)",
            borderRadius: 999,
            border: 0,
            outline: "var(--hairline) solid color-mix(in oklch, var(--state-blocked) 38%, transparent)",
            outlineOffset: -1,
            background: "var(--state-blocked-soft)",
            color: "color-mix(in oklch, var(--state-blocked) 80%, var(--fg))",
            opacity: busy ? 0.6 : 1,
          }}
        >
          {busy ? "Opening fix chat…" : `Fix with ${name}`}
        </button>
      </div>
    </section>
  );
}

/** One degraded repo (or tree) line: mono URL + what state the local copy is in. */
function DegradedRow({
  url,
  status,
  reason,
  headCommit,
  tag,
}: {
  url: string;
  status: "stale" | "unreachable";
  reason: string;
  headCommit?: string;
  tag?: string;
}) {
  const detail =
    status === "unreachable"
      ? `no local copy — ${reason}`
      : `frozen at ${headCommit ? headCommit.slice(0, 7) : "last sync"}, won't self-heal — ${reason}`;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
      <span className="flex items-center" style={{ gap: 6, minWidth: 0 }}>
        <span
          className="mono text-label"
          style={{ color: "var(--fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {url}
        </span>
        {tag ? (
          <span
            className="text-label"
            style={{
              flexShrink: 0,
              padding: "0 var(--sp-1_5)",
              borderRadius: 999,
              background: "var(--state-blocked-soft)",
              color: "color-mix(in oklch, var(--state-blocked) 80%, var(--fg))",
            }}
          >
            {tag}
          </span>
        ) : null}
      </span>
      <span className="text-label" style={{ color: "color-mix(in oklch, var(--state-blocked) 70%, var(--fg))" }}>
        {detail}
      </span>
    </div>
  );
}

/**
 * Same DOM as DisconnectChip's PulseDot (solid dot + `ring-pulse` ring),
 * recoloured to the caution token — shared visual vocabulary, different
 * severity.
 */
function AmberDot() {
  return (
    <span
      aria-hidden="true"
      style={{ position: "relative", width: 8, height: 8, flexShrink: 0, display: "inline-block" }}
    >
      <span
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: "50%",
          background: "var(--state-blocked)",
        }}
      />
      <span
        style={{
          position: "absolute",
          inset: -3,
          borderRadius: "50%",
          border: "var(--hairline) solid var(--state-blocked)",
          animation: "ring-pulse 1.8s infinite",
          opacity: 0.6,
        }}
      />
    </span>
  );
}
