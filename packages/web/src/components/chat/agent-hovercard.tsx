import type { AgentChatStatus } from "@first-tree/shared";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, MessageSquare } from "lucide-react";
import { type ReactNode, useContext } from "react";
import { useNavigate } from "react-router";
import { chatAgentStatusQueryKey, fetchChatAgentStatuses } from "../../api/agent-status.js";
import { getAgent } from "../../api/agents.js";
import { getChat } from "../../api/chats.js";
import { reconcileLiveTurn, viewOf } from "../../lib/agent-status-view.js";
import { useClientMap } from "../../lib/use-client-map.js";
import { useMemberNameMap } from "../../lib/use-member-name-map.js";
import { Avatar } from "../avatar.js";
import { Button } from "../ui/button.js";
import { HoverCard, type HoverCardPlacement } from "../ui/hover-card.js";
import { StatusGlyph } from "../ui/status-glyph.js";
import { LiveTurnAgentsContext } from "./live-turn-context.js";
import { WorkingChip } from "./working-chip.js";

/**
 * Shared agent identity hovercard. Wraps any trigger (avatar + name cluster) and,
 * on hover/focus, previews the agent's identity + live status + Owner / Runs-on,
 * with `Open details →` / `Chat` actions — so a user in a chat has an in-context
 * door to the agent without leaving the conversation.
 *
 * Two-pass data (never blocks on a fetch):
 *  - Pass A (instant): identity + type/role from the chat participant list and
 *    live status from the chat agent-status — both already cached by ChatView.
 *  - Pass B (lazy on open): Owner + Runs-on from a single getAgent(agentId)
 *    (managerId → member name; runtimeProvider + clientId → hostname). The body
 *    only mounts when the card opens, so this query is naturally lazy.
 */
export function AgentHovercard({
  agentId,
  chatId,
  name,
  placement = "bottom",
  triggerClassName,
  children,
}: {
  agentId: string;
  chatId: string;
  /**
   * Display name of the target, for the trigger's accessible label. Required so
   * each trigger announces a distinct name — without it the fixed label would
   * override the visible name text and read identically for every agent.
   */
  name: string;
  placement?: HoverCardPlacement;
  triggerClassName?: string;
  children: ReactNode;
}) {
  return (
    <HoverCard
      placement={placement}
      ariaLabel={`${name} — view details`}
      triggerClassName={triggerClassName}
      // Card chrome (background / border / shadow / padding) comes from the
      // HoverCard primitive; only the width is this consumer's call.
      contentStyle={{
        width: "var(--sp-70)",
        maxWidth: "calc(100vw - var(--sp-4))",
      }}
      content={({ close }) => <AgentHovercardBody agentId={agentId} chatId={chatId} onAction={close} />}
    >
      {children}
    </HoverCard>
  );
}

function AgentHovercardBody({ agentId, chatId, onAction }: { agentId: string; chatId: string; onAction: () => void }) {
  const navigate = useNavigate();
  const resolveMember = useMemberNameMap();
  const { resolve: resolveClient } = useClientMap();

  // Pass A — cached by ChatView, so these are hits (instant). staleTime keeps a
  // warm cache from refetching on every card open: scanning many names in a busy
  // timeline/sidebar would otherwise fire a GET /chats/:id + /agent-status per
  // hover. ChatView's own observers (agent-status refetchInterval + WS
  // invalidation) keep the data fresh; the card only needs to read it.
  const chatQ = useQuery({
    queryKey: ["chat-detail", chatId],
    queryFn: () => getChat(chatId),
    staleTime: 30_000,
  });
  const statusQ = useQuery({
    queryKey: chatAgentStatusQueryKey(chatId),
    queryFn: () => fetchChatAgentStatuses(chatId),
    staleTime: 30_000,
  });

  const participant = chatQ.data?.participants.find((p) => p.agentId === agentId);
  const rawStatus: AgentChatStatus | null = statusQ.data?.find((s) => s.agentId === agentId) ?? null;
  // Match the roster row from the same context: a live timeline turn upgrades
  // `ready → working` (at the axis level) so the card's status dot / LIVE pill
  // can't disagree with a visibly-working turn — for every hovercard entry
  // point (roster rows AND message avatars/names) by construction.
  const liveTurnAgentIds = useContext(LiveTurnAgentsContext);
  const status: AgentChatStatus | null = rawStatus ? reconcileLiveTurn(rawStatus, liveTurnAgentIds.has(agentId)) : null;

  // Pass B — lazy: this body only mounts while the card is open. Gated on the
  // chat (Pass A) resolving so the human check is decided from real data —
  // otherwise a cold-cache open would fire getAgent before we know the type and
  // 404 on a human. In practice ChatView keeps Pass A warm, so this is instant.
  const agentQ = useQuery({
    queryKey: ["agent", agentId],
    queryFn: () => getAgent(agentId),
    enabled: chatQ.isSuccess && participant?.type !== "human",
    staleTime: 30_000,
  });

  const isHuman = (participant?.type ?? agentQ.data?.type) === "human";
  const displayName = participant?.displayName ?? agentQ.data?.displayName ?? "…";
  const handle = participant?.name ?? agentQ.data?.name ?? agentId.slice(0, 8);
  const avatarImageUrl = participant?.avatarImageUrl ?? agentQ.data?.avatarImageUrl ?? null;
  const avatarColorToken = participant?.avatarColorToken ?? agentQ.data?.avatarColorToken ?? null;

  const main = status?.main;
  const isWorking = main === "working" || main === "failed";
  const workingActivity = isWorking ? (status?.activity ?? null) : null;
  // Pass B 404s for a private agent visible only via chat membership (getAgent +
  // the agent-detail route are both visibility-gated). When that happens, drop
  // the Owner/Runs-on rows and the Open details action rather than show dashes
  // and route to a page the viewer can't open.
  const detailsAccessible = !agentQ.isError;
  const showMeta = detailsAccessible || workingActivity !== null;

  function openDetails() {
    onAction();
    navigate(`/agents/${agentId}/profile`);
  }
  function openChat() {
    onAction();
    // Type-agnostic draft compose (same path as the agent-detail Chat button);
    // works for agents and humans without an agent-vs-human chat-create fork.
    navigate(`/?c=draft&with=${encodeURIComponent(agentId)}`);
  }

  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-2_5)" }}>
      {/* Head */}
      <div className="flex items-center" style={{ gap: "var(--sp-2_5)" }}>
        <span className="relative shrink-0" style={{ width: 38, height: 38 }}>
          <Avatar src={avatarImageUrl} name={displayName} seed={agentId} colorToken={avatarColorToken} size={38} />
          {!isHuman && status ? <StatusDot status={status} /> : null}
        </span>
        <div className="flex min-w-0 flex-1 flex-col" style={{ gap: 1 }}>
          <div className="truncate text-subtitle" style={{ color: "var(--fg)" }}>
            {displayName}
          </div>
          <div className="mono text-caption truncate" style={{ color: "var(--fg-4)" }}>
            @{handle}
          </div>
        </div>
        {!isHuman && main === "working" ? (
          <span className="mono text-eyebrow shrink-0" style={{ color: "var(--state-working)" }}>
            LIVE
          </span>
        ) : null}
      </div>

      {/* Agent-only meta + actions. Humans get just a Message action. */}
      {isHuman ? (
        <>
          <Divider />
          <Button size="sm" variant="outline" onClick={openChat}>
            <MessageSquare className="h-4 w-4" />
            Message
          </Button>
        </>
      ) : (
        <>
          {showMeta ? (
            <>
              <Divider />
              <div className="flex flex-col" style={{ gap: "var(--sp-1_5)" }}>
                {detailsAccessible ? (
                  <>
                    <MetaRow label="Owner">
                      {agentQ.isLoading ? <Skeleton /> : resolveMember(agentQ.data?.managerId)}
                    </MetaRow>
                    <MetaRow label="Runs on">
                      {agentQ.isLoading ? (
                        <Skeleton />
                      ) : agentQ.data?.clientId ? (
                        <span className="mono">
                          {agentQ.data.runtimeProvider} ·{" "}
                          {resolveClient(agentQ.data.clientId)?.hostname ?? agentQ.data.clientId}
                        </span>
                      ) : (
                        <span style={{ color: "var(--fg-4)" }}>— not bound</span>
                      )}
                    </MetaRow>
                  </>
                ) : null}
                {workingActivity ? (
                  <MetaRow label="Working">
                    <WorkingChip activity={workingActivity} showDot={false} />
                  </MetaRow>
                ) : null}
              </div>
            </>
          ) : null}
          <Divider />
          <div className="flex" style={{ gap: "var(--sp-2)" }}>
            {detailsAccessible ? (
              <>
                <Button size="sm" onClick={openDetails} style={{ flex: 1 }}>
                  Open details
                  <ArrowRight className="h-4 w-4" />
                </Button>
                <Button size="sm" variant="ghost" onClick={openChat}>
                  <MessageSquare className="h-4 w-4" />
                  Chat
                </Button>
              </>
            ) : (
              // Pass B 404 → a private agent the viewer can see in chat but not
              // open via /agents/:uuid. Hide Owner/Runs-on + Open details (they'd
              // 404); keep Chat (they already share this chat).
              <Button size="sm" variant="outline" onClick={openChat} style={{ flex: 1 }}>
                <MessageSquare className="h-4 w-4" />
                Chat
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid items-baseline" style={{ gridTemplateColumns: "var(--sp-16) 1fr", gap: "var(--sp-2)" }}>
      <div className="text-eyebrow" style={{ color: "var(--fg-4)" }}>
        {label}
      </div>
      <div className="text-caption min-w-0 truncate" style={{ color: "var(--fg-2)" }}>
        {children}
      </div>
    </div>
  );
}

function Divider() {
  return <div style={{ borderTop: "var(--hairline) solid var(--border-faint)" }} />;
}

function Skeleton() {
  return (
    <span
      aria-hidden
      className="inline-block rounded-[var(--radius-chip)]"
      style={{ width: "var(--sp-20)", height: "var(--sp-2_5)", background: "var(--bg-sunken)" }}
    />
  );
}

/**
 * The avatar status dot — same `viewOf` vocabulary (shape / colour / pulse) as
 * the right-sidebar AgentStatusRow, so an agent reads identically in both places.
 */
function StatusDot({ status }: { status: AgentChatStatus }) {
  const view = viewOf(status.main);
  return (
    <span className="absolute" style={{ right: -2, bottom: -3 }}>
      <StatusGlyph
        colorVar={view.colorVar}
        shape={view.shape}
        pulse={view.pulse}
        size={9}
        ariaLabel={view.label}
        separator
      />
    </span>
  );
}
