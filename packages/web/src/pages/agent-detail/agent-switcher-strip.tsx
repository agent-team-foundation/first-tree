import type { Agent } from "@first-tree/shared";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { listAgents, listAllAgents } from "../../api/agents.js";
import { useAuth } from "../../auth/auth-context.js";
import { Avatar } from "../../components/avatar.js";
import { matchesAgentScope, readAgentFilterPreference } from "../team/agent-filter.js";
import { fetchAllAgents } from "../team/index.js";
import { resolveTabPath } from "./tabs.js";

/**
 * Agent switcher (vertical-B): replaces the breadcrumb at the top of agent
 * detail. A "‹ Team" back affordance pinned at the left, then a horizontal strip
 * of avatar-over-name items (the current agent selected). The Team anchor lives
 * OUTSIDE the scroll container, so the only "back to the roster" exit stays put
 * no matter how far right you scroll through a long agent list. Switching agents
 * (and Team) goes through `onNavigate` = the page's `navigateAway` (plain
 * navigate — every setting saves immediately, so leaving is never destructive).
 *
 * Scope follows the Team page's All/Mine preference (shared `agent-filter`
 * module), read once on mount — the filter can only change on the Team page,
 * where this strip is unmounted, so read-on-mount fully covers a single tab.
 * The current agent is always included even when scope would exclude it.
 */
export function AgentSwitcherStrip({
  currentAgent,
  currentTabPath,
  onNavigate,
}: {
  currentAgent: Agent;
  currentTabPath: string;
  onNavigate: (to: string) => void;
}) {
  const { memberId, role } = useAuth();
  const isAdmin = role === "admin";
  // Read-on-mount (see header comment): the All/Mine toggle lives on the Team
  // page; while this strip is mounted the preference cannot change.
  const [filter] = useState(() => readAgentFilterPreference());

  const agentsQuery = useQuery({
    // Same key + fetcher as the Team page, so navigating from Team is a cache hit.
    queryKey: ["agents", "team-page", isAdmin ? "admin" : "member"],
    queryFn: () => fetchAllAgents((params) => (isAdmin ? listAllAgents(params) : listAgents(params))),
    // Mirror the Team page cadence so the roster (added/removed/renamed agents)
    // stays fresh while you're parked on one agent's detail page.
    refetchInterval: 10_000,
  });

  const all = agentsQuery.data ?? [];
  // Switcher lists agents (not human members); the current agent is force-included
  // even if scope/type would exclude it, so you can always see where you are.
  const inScope = all.filter((a) => a.type !== "human" && matchesAgentScope(a, filter, memberId));
  const base: Agent[] = inScope.some((a) => a.uuid === currentAgent.uuid)
    ? inScope
    : [currentAgent, ...inScope.filter((a) => a.uuid !== currentAgent.uuid)];
  // Render the current agent from the live (10s-polled) `currentAgent` prop, not
  // the switcher query row, so the selected chip's name/avatar never lags the
  // header for the agent you're actually on.
  const items: Agent[] = base.map((a) => (a.uuid === currentAgent.uuid ? currentAgent : a));

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const updateEdges = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const maxScroll = el.scrollWidth - el.clientWidth;
    setEdges({ left: el.scrollLeft > 1, right: el.scrollLeft < maxScroll - 1 });
  }, []);

  // Keep the selected agent in horizontal view and refresh the fades when the
  // list changes. Adjust scrollLeft directly (NOT scrollIntoView) so we never
  // scroll the PAGE vertically back up to the header when the user is deep in a tab.
  // biome-ignore lint/correctness/useExhaustiveDependencies: currentAgent.uuid / items.length drive the re-scroll; reading the DOM, not these values.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const active = el.querySelector<HTMLElement>('[aria-current="true"]');
    if (active) {
      const aRect = active.getBoundingClientRect();
      const cRect = el.getBoundingClientRect();
      if (aRect.left < cRect.left) el.scrollLeft += aRect.left - cRect.left;
      else if (aRect.right > cRect.right) el.scrollLeft += aRect.right - cRect.right;
    }
    updateEdges();
  }, [currentAgent.uuid, items.length, updateEdges]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(updateEdges);
    ro.observe(el);
    return () => ro.disconnect();
  }, [updateEdges]);

  return (
    // Pinned Team anchor + an independently-scrolling agent strip beside it.
    <div className="flex items-start" style={{ gap: "var(--sp-2)" }}>
      <StripButton onClick={() => onNavigate("/team")} label="Team" ariaLabel="Back to team">
        <span
          className="flex items-center justify-center shrink-0"
          style={{
            width: 28,
            height: 28,
            borderRadius: "var(--radius-full)",
            border: "var(--hairline) solid var(--border)",
            background: "var(--bg-raised)",
            color: "var(--fg-3)",
          }}
        >
          <ChevronLeft className="h-4 w-4" />
        </span>
      </StripButton>

      {/* min-width:0 lets this flex child shrink below its content so the inner
          row can actually overflow and scroll instead of pushing the layout wide. */}
      <div style={{ position: "relative", flex: "1 1 auto", minWidth: 0 }}>
        <div
          ref={scrollRef}
          onScroll={updateEdges}
          className="flex items-start"
          style={{ gap: "var(--sp-2)", overflowX: "auto", paddingBottom: "var(--sp-1)" }}
        >
          {items.map((a) => {
            const selected = a.uuid === currentAgent.uuid;
            return (
              <StripButton
                key={a.uuid}
                ariaCurrent={selected}
                label={a.displayName}
                title={a.displayName}
                // Clicking the already-selected agent is a no-op — it isn't a
                // "leave", so it must not trip the leave guard (which would offer to
                // discard the draft for a navigation back to the same page).
                onClick={
                  selected
                    ? undefined
                    : () => onNavigate(`/agents/${a.uuid}/${resolveTabPath(a, memberId, role, currentTabPath)}`)
                }
              >
                {/* Demoted switcher (the page header's title row is the primary
                  identity, with a larger avatar): these nav avatars are deliberately
                  smaller, and selection is a quiet bg-active disc behind the avatar
                  plus the fg-weighted label below — NOT a tab-style underline, which
                  would make the switcher compete with the title for "you are here".
                  No presence dot: this strip is a switcher, not a roster — runtime
                  status already lives in the header's PresenceChip. */}
                <span
                  className="inline-flex items-center justify-center shrink-0"
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: "var(--radius-full)",
                    border: "var(--hairline) solid transparent",
                    background: selected ? "var(--bg-active)" : "transparent",
                  }}
                >
                  <Avatar
                    src={a.avatarImageUrl}
                    name={a.displayName}
                    size={26}
                    colorToken={a.avatarColorToken}
                    seed={a.uuid}
                  />
                </span>
              </StripButton>
            );
          })}
        </div>
        {edges.left ? <EdgeFade side="left" /> : null}
        {edges.right ? <EdgeFade side="right" /> : null}
      </div>
    </div>
  );
}

function StripButton({
  children,
  label,
  title,
  ariaLabel,
  ariaCurrent,
  onClick,
}: {
  children: ReactNode;
  label: string;
  title?: string;
  ariaLabel?: string;
  ariaCurrent?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      aria-current={ariaCurrent ? "true" : undefined}
      title={title}
      className="flex shrink-0 cursor-pointer flex-col items-center bg-transparent border-0 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-[var(--radius-input)]"
      // Width follows the name within a tight band — floor sp-16 (short names keep
      // a stable, avatar-centered column), cap at 100 (just above sp-20) so common
      // names like gandy-developer / gandy-assistant show in full or near-full
      // without the column going wide and stranding the small avatar in whitespace.
      // Past the cap the label ellipsizes. Raw 100 (no token at this step, like the
      // avatar's raw size) — the scale jumps sp-20(80) → sp-35(140), both worse here.
      style={{
        gap: "var(--sp-1)",
        padding: "var(--sp-1) var(--sp-1_5)",
        minWidth: "var(--sp-16)",
        maxWidth: 100,
      }}
    >
      {children}
      {/* Selected = label in full fg (others fg-3) + the bg-active disc behind the
          avatar above. No underline: the switcher is demoted nav, not a tab row —
          the page title is the primary "you are here". */}
      <span
        className="text-caption max-w-full truncate text-center"
        style={{ color: ariaCurrent ? "var(--fg)" : "var(--fg-3)" }}
      >
        {label}
      </span>
    </button>
  );
}

function EdgeFade({ side }: { side: "left" | "right" }) {
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        top: 0,
        bottom: 0,
        left: side === "left" ? 0 : undefined,
        right: side === "right" ? 0 : undefined,
        width: "var(--sp-6)",
        pointerEvents: "none",
        background: `linear-gradient(to ${side === "left" ? "right" : "left"}, var(--bg), transparent)`,
      }}
    />
  );
}
