import type { Agent } from "@first-tree/shared";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { listAgents, listAllAgents } from "../../api/agents.js";
import { useAuth } from "../../auth/auth-context.js";
import { Avatar } from "../../components/avatar.js";
import { presenceChipView, runtimeStateToPresence } from "../../components/ui/presence-chip.js";
import { matchesAgentScope, readAgentFilterPreference } from "../team/agent-filter.js";
import { fetchAllAgents } from "../team/index.js";
import { resolveTabPath } from "./tabs.js";

/**
 * Agent switcher (vertical-B): replaces the breadcrumb at the top of agent
 * detail. A horizontal strip of avatar-over-name items, leftmost a "‹ Team"
 * back affordance, the current agent selected. Switching agents (and Team) goes
 * through `onNavigate` = the page's `guardedNavigate`, so an unsaved config
 * draft prompts a confirm before leaving.
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
    // Mirror the Team page cadence so other agents' presence dots stay fresh.
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
  // the switcher query row, so the selected chip's name/avatar/presence never
  // lags the header for the agent you're actually on.
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
    <div style={{ position: "relative" }}>
      <div
        ref={scrollRef}
        onScroll={updateEdges}
        className="flex items-start"
        style={{ gap: "var(--sp-2)", overflowX: "auto", paddingBottom: "var(--sp-1)" }}
      >
        <StripButton onClick={() => onNavigate("/team")} label="Team" ariaLabel="Back to team">
          <span
            className="flex items-center justify-center shrink-0"
            style={{
              width: 36,
              height: 36,
              borderRadius: "var(--radius-full)",
              border: "var(--hairline) solid var(--border)",
              background: "var(--bg-raised)",
              color: "var(--fg-3)",
            }}
          >
            <ChevronLeft className="h-4 w-4" />
          </span>
        </StripButton>

        {items.map((a) => {
          const selected = a.uuid === currentAgent.uuid;
          const presence = presenceChipView(runtimeStateToPresence(a.runtimeState));
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
              {/* Selection is signalled by the label underline + weight below
                  (tab-style), not a heavy/colored ring around the avatar — so the
                  avatar size is constant (no select-time shrink/jump) and follows
                  the OptionCard rule of never using a heavier border for selection. */}
              <span className="relative inline-flex shrink-0" style={{ width: 36, height: 36 }}>
                <span
                  className="inline-flex items-center justify-center"
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: "var(--radius-full)",
                    border: "var(--hairline) solid transparent",
                    background: selected ? "var(--bg-active)" : "transparent",
                  }}
                >
                  <Avatar
                    src={a.avatarImageUrl}
                    name={a.displayName}
                    size={34}
                    colorToken={a.avatarColorToken}
                    seed={a.uuid}
                  />
                </span>
                <span
                  aria-hidden
                  className="absolute inline-block rounded-full"
                  style={{
                    right: 0,
                    bottom: 0,
                    width: "var(--sp-2)",
                    height: "var(--sp-2)",
                    background: presence.color,
                    boxShadow: "0 0 0 var(--hairline-bold) var(--bg-raised)",
                  }}
                />
              </span>
            </StripButton>
          );
        })}
      </div>
      {edges.left ? <EdgeFade side="left" /> : null}
      {edges.right ? <EdgeFade side="right" /> : null}
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
      style={{ gap: "var(--sp-1)", padding: "var(--sp-1) var(--sp-0_5)", width: "var(--sp-16)" }}
    >
      {children}
      <span
        className="text-caption max-w-full truncate text-center"
        style={{
          color: ariaCurrent ? "var(--fg)" : "var(--fg-3)",
          paddingBottom: "var(--sp-0_5)",
          borderBottom: ariaCurrent
            ? "var(--hairline-bold) solid var(--primary)"
            : "var(--hairline-bold) solid transparent",
        }}
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
