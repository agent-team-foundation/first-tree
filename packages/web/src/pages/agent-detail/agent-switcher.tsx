import type { Agent } from "@first-tree/shared";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown } from "lucide-react";
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { listAgents, listAllAgents } from "../../api/agents.js";
import { useAuth } from "../../auth/auth-context.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Popover } from "../../components/ui/popover.js";

import { fetchAllAgents, orderAgentsLikeTeam } from "../team/index.js";

/** Above this many switch targets the panel gains a filter input. */
const SEARCH_THRESHOLD = 8;

// Keyboard navigation moves real DOM focus between rows, so the focused row
// carries the same background highlight as a hovered one — a menu, not a
// focus-ringed form control.
const ROW_CLASS =
  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-body transition-colors hover:bg-[var(--bg-hover)] focus:bg-[var(--bg-hover)] focus:outline-none";

const ROW_SELECTOR = 'button[role="menuitemradio"]';

/**
 * Breadcrumb-anchored agent switcher.
 *
 * The breadcrumb's current segment already answers "which agent am I looking
 * at"; this makes it answer "and I can change it" without growing the header.
 * Deliberately plain — no avatar, no presence, no grouping — so the resting
 * state is the same breadcrumb text plus one chevron, and the Team page stays
 * the place to browse the roster.
 */
export function AgentSwitcher({ currentAgent, onSelect }: { currentAgent: Agent; onSelect: (uuid: string) => void }) {
  // Hover is tracked in state rather than a `group-hover:` class, matching how
  // the sibling `BreadcrumbLink` swaps its own hover color.
  const [hovered, setHovered] = useState(false);
  return (
    <Popover
      align="start"
      offset={6}
      panelAriaLabel="Switch agent"
      panelStyle={{ width: "var(--sp-70)", padding: "var(--sp-1) 0" }}
      trigger={({ open, toggle }) => (
        <button
          type="button"
          // Still the breadcrumb's current segment — becoming a menu trigger
          // must not cost it that meaning.
          aria-current="page"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`Switch agent, current: ${currentAgent.displayName}`}
          onClick={toggle}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          onKeyDown={(e) => {
            if (open || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
            e.preventDefault();
            toggle();
          }}
          // Borderless by design (it must still read as breadcrumb text), so
          // focus uses the §13 thin neutral ring rather than a border that
          // would break the breadcrumb's flat line.
          className="inline-flex min-h-11 cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-body font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          style={{ color: "var(--fg)" }}
        >
          <span className="truncate">{currentAgent.displayName}</span>
          {/* The name already sits at full contrast, so the chevron is what
              deepens on hover and while the menu is open. */}
          <ChevronDown
            className="h-3.5 w-3.5 flex-none transition-colors"
            style={{ color: open || hovered ? "var(--fg)" : "var(--fg-3)" }}
          />
        </button>
      )}
    >
      {({ close }) => <AgentSwitcherPanel currentAgent={currentAgent} onSelect={onSelect} close={close} />}
    </Popover>
  );
}

/**
 * Split out so the filter text and the list query mount with the panel: every
 * open starts unfiltered, and a closed switcher holds no query observer.
 */
function AgentSwitcherPanel({
  currentAgent,
  onSelect,
  close,
}: {
  currentAgent: Agent;
  onSelect: (uuid: string) => void;
  close: () => void;
}) {
  const { role, memberId } = useAuth();
  const isAdmin = role === "admin";
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const autoFocusedForRef = useRef<"none" | "error" | "list">("none");
  const [filter, setFilter] = useState("");

  // Same query key, source, and order as the Team page, so the switcher shows
  // the roster the user just came from — and opens against a warm cache.
  const agentsQuery = useQuery({
    queryKey: ["agents", "team-page", isAdmin ? "admin" : "member"],
    queryFn: () => fetchAllAgents((params) => (isAdmin ? listAllAgents(params) : listAgents(params))),
  });

  const options = useMemo(() => {
    const agents = (agentsQuery.data ?? []).filter((a) => a.type !== "human");
    // A member's list is visibility-filtered, so the agent currently open can
    // legitimately be absent from it. Keep it present, or the list would show
    // no checked row at all.
    const withCurrent = agents.some((a) => a.uuid === currentAgent.uuid) ? agents : [...agents, currentAgent];
    // The server returns `createdAt DESC`; Team reorders client-side. Reuse
    // that rule so the two surfaces can't disagree about where an agent sits.
    return orderAgentsLikeTeam(withCurrent, memberId);
  }, [agentsQuery.data, currentAgent, memberId]);

  // Display names are not unique. Disambiguate with the handle only where it
  // is actually needed, so the common case stays a bare list of names.
  const ambiguousNames = useMemo(() => {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const agent of options) {
      if (seen.has(agent.displayName)) duplicates.add(agent.displayName);
      else seen.add(agent.displayName);
    }
    return duplicates;
  }, [options]);

  const showFilter = options.length > SEARCH_THRESHOLD;
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return options;
    return options.filter(
      (a) => a.displayName.toLowerCase().includes(needle) || (a.name ?? "").toLowerCase().includes(needle),
    );
  }, [options, filter]);

  // Land the keyboard on something meaningful each time the panel's content
  // changes shape: Retry while the roster is broken, then the filter input or
  // the agent already open once a list exists. Tracking which shape we focused
  // for (rather than a one-shot flag) is what lets a successful retry hand the
  // keyboard on to the rows it just rendered.
  useEffect(() => {
    if (agentsQuery.isError && autoFocusedForRef.current !== "error") {
      autoFocusedForRef.current = "error";
      retryRef.current?.focus();
      return;
    }
    if (!agentsQuery.isSuccess || autoFocusedForRef.current === "list") return;
    autoFocusedForRef.current = "list";
    if (inputRef.current) {
      inputRef.current.focus();
      return;
    }
    const rows = listRef.current;
    (
      rows?.querySelector<HTMLButtonElement>(`${ROW_SELECTOR}[aria-checked="true"]`) ??
      rows?.querySelector<HTMLButtonElement>(ROW_SELECTOR)
    )?.focus();
  }, [agentsQuery.isError, agentsQuery.isSuccess]);

  function pick(uuid: string) {
    close();
    // Re-selecting the open agent is a no-op rather than a self-navigation
    // that would push a duplicate history entry.
    if (uuid === currentAgent.uuid) return;
    onSelect(uuid);
  }

  // Bound to the filter input and the menu itself (both already interactive)
  // rather than to the panel wrapper, so the container stays a plain div.
  function onPanelKeyDown(e: ReactKeyboardEvent<HTMLElement>) {
    if (e.key === "Tab") {
      close();
      return;
    }
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>(ROW_SELECTOR) ?? []);
    if (rows.length === 0) return;
    // Enter on a row is the button's own activation; from the filter input it
    // commits the top match.
    if (e.key === "Enter") {
      if ((e.target as HTMLElement).tagName !== "INPUT") return;
      e.preventDefault();
      rows[0]?.click();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    if (e.key === "Home") {
      rows[0]?.focus();
      return;
    }
    if (e.key === "End") {
      rows[rows.length - 1]?.focus();
      return;
    }
    const active = rows.indexOf(document.activeElement as HTMLButtonElement);
    const step = e.key === "ArrowDown" ? 1 : -1;
    const next = active === -1 ? (step === 1 ? 0 : rows.length - 1) : active + step;
    rows[(next + rows.length) % rows.length]?.focus();
  }

  return (
    <div>
      {showFilter && (
        <div style={{ padding: "var(--sp-1) var(--sp-2) var(--sp-1_5)" }}>
          <Input
            ref={inputRef}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={onPanelKeyDown}
            placeholder="Find an agent"
            aria-label="Find an agent"
            className="h-8"
          />
        </div>
      )}

      {agentsQuery.isPending ? (
        <div className="text-body" style={{ padding: "var(--sp-1_5) var(--sp-3)", color: "var(--fg-3)" }}>
          Loading agents…
        </div>
      ) : agentsQuery.isError ? (
        // Scoped to the panel — the detail page behind it stays usable.
        <div
          role="alert"
          className="flex flex-col items-start gap-2 text-body"
          style={{ padding: "var(--sp-1_5) var(--sp-3)", color: "var(--fg-3)" }}
        >
          <span>Couldn’t load agents.</span>
          <Button ref={retryRef} size="xs" variant="outline" onClick={() => void agentsQuery.refetch()}>
            Retry
          </Button>
        </div>
      ) : visible.length === 0 ? (
        // `options` always carries the open agent, so an empty list can only
        // mean the filter matched nothing.
        <div className="text-body" style={{ padding: "var(--sp-1_5) var(--sp-3)", color: "var(--fg-3)" }}>
          No matching agents
        </div>
      ) : (
        <div ref={listRef} role="menu" aria-label="Agents" aria-orientation="vertical" onKeyDown={onPanelKeyDown}>
          {visible.map((agent) => {
            const isCurrent = agent.uuid === currentAgent.uuid;
            return (
              <button
                key={agent.uuid}
                type="button"
                role="menuitemradio"
                aria-checked={isCurrent}
                tabIndex={-1}
                onClick={() => pick(agent.uuid)}
                className={ROW_CLASS}
                style={{ color: "var(--fg)" }}
              >
                <span className="min-w-0 flex-1 truncate" title={agent.displayName}>
                  <span className={isCurrent ? "font-medium" : undefined}>{agent.displayName}</span>
                  {ambiguousNames.has(agent.displayName) && agent.name ? (
                    <span className="mono text-caption" style={{ color: "var(--fg-3)", marginLeft: "var(--sp-1_5)" }}>
                      @{agent.name}
                    </span>
                  ) : null}
                </span>
                <span className="inline-flex flex-none justify-center" style={{ width: 14 }}>
                  {isCurrent ? <Check className="h-3.5 w-3.5" aria-hidden /> : null}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
