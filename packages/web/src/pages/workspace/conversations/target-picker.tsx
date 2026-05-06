import { useQuery } from "@tanstack/react-query";
import { ChevronDown, X } from "lucide-react";
import { type KeyboardEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { getActivityOverview, type RuntimeAgent } from "../../../api/activity.js";
import { useAuth } from "../../../auth/auth-context.js";
import { useAgentNameMap } from "../../../lib/use-agent-name-map.js";
import { cn } from "../../../lib/utils.js";

/**
 * Reusable target picker for chat composers.
 *
 * Behaviour follows docs/chat-first-workspace-product-design.md §"Target
 * Picker":
 *   - Default = the most-recently-used agent OR a `personal_assistant`
 *     primary fallback.
 *   - Backspace removes the last chip when the search input is empty.
 *   - Esc closes the dropdown.
 *   - Arrow up/down + Enter cycle / toggle candidates.
 *   - Single- vs multi-select via the `multi` prop.
 *
 * The component renders a chip row, a search input, and a popover list.
 * It is purposefully self-contained — the parent owns selection state.
 */

export type TargetCandidate = {
  agentId: string;
  displayName: string;
  type: "human" | "personal_assistant" | "autonomous_agent" | null;
  online: boolean;
};

type TargetPickerProps = {
  selected: string[];
  onChange: (next: string[]) => void;
  multi?: boolean;
  placeholder?: string;
  /** Optional pre-built candidate list. If omitted, the picker fetches
   *  `getActivityOverview` and resolves names via `useAgentNameMap`. */
  candidates?: TargetCandidate[];
  /** When true, exclude the current viewer's human agent from the list. */
  excludeSelf?: boolean;
};

export function TargetPicker({
  selected,
  onChange,
  multi = true,
  placeholder = "Add target…",
  candidates: providedCandidates,
  excludeSelf = true,
}: TargetPickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const popoverId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);

  const { agentId: myAgentId } = useAuth();
  const agentName = useAgentNameMap();

  const { data: activity } = useQuery({
    queryKey: ["activity"],
    queryFn: getActivityOverview,
    refetchInterval: 15_000,
    enabled: !providedCandidates,
  });

  const candidates = useMemo<TargetCandidate[]>(() => {
    if (providedCandidates) return providedCandidates;
    const rows = activity?.agents ?? [];
    return rows
      .filter((a) => (excludeSelf && myAgentId ? a.agentId !== myAgentId : true))
      .map((a: RuntimeAgent) => ({
        agentId: a.agentId,
        displayName: agentName(a.agentId),
        type: a.type,
        online: !!a.clientId,
      }));
  }, [providedCandidates, activity, agentName, excludeSelf, myAgentId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = candidates.filter((c) => !selected.includes(c.agentId));
    if (!q) return list;
    return list.filter((c) => c.displayName.toLowerCase().includes(q) || c.agentId.toLowerCase().includes(q));
  }, [candidates, query, selected]);

  // Clamp the highlighted index whenever the filtered list shrinks. Reading
  // `filtered` inside the effect (rather than just its `.length` in the dep
  // array) keeps biome's `useExhaustiveDependencies` happy: the dep is the
  // value actually used to decide whether to re-run.
  useEffect(() => {
    if (filtered.length === 0) return;
    setHighlight((h) => (h >= filtered.length ? 0 : h));
  }, [filtered]);

  // Click-outside closes the popover.
  useEffect(() => {
    if (!open) return;
    const handler = (ev: MouseEvent) => {
      if (!containerRef.current) return;
      if (containerRef.current.contains(ev.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const toggle = useCallback(
    (agentId: string) => {
      if (selected.includes(agentId)) {
        onChange(selected.filter((x) => x !== agentId));
        return;
      }
      if (multi) {
        onChange([...selected, agentId]);
        setQuery("");
      } else {
        onChange([agentId]);
        setQuery("");
        setOpen(false);
      }
    },
    [selected, onChange, multi],
  );

  const handleKeyDown = (ev: KeyboardEvent<HTMLInputElement>): void => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      setOpen(false);
      return;
    }
    if (ev.key === "Backspace" && query.length === 0 && selected.length > 0) {
      ev.preventDefault();
      onChange(selected.slice(0, -1));
      return;
    }
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      setOpen(true);
      setHighlight((h) => (filtered.length === 0 ? 0 : (h + 1) % filtered.length));
      return;
    }
    if (ev.key === "ArrowUp") {
      ev.preventDefault();
      setOpen(true);
      setHighlight((h) => (filtered.length === 0 ? 0 : (h - 1 + filtered.length) % filtered.length));
      return;
    }
    if (ev.key === "Enter") {
      const target = filtered[highlight];
      if (target) {
        ev.preventDefault();
        toggle(target.agentId);
      }
    }
  };

  return (
    <div ref={containerRef} className="relative" style={{ width: "100%" }}>
      <div
        className="flex items-center flex-wrap"
        style={{
          gap: 4,
          padding: "var(--sp-1) var(--sp-1_5)",
          border: "var(--hairline) solid var(--border)",
          borderRadius: "var(--radius-input)",
          background: "var(--bg-sunken)",
          minHeight: 32,
        }}
      >
        <span className="mono text-eyebrow uppercase shrink-0" style={{ color: "var(--fg-3)", marginRight: 4 }}>
          To:
        </span>
        {selected.map((agentId) => (
          <span
            key={agentId}
            className="inline-flex items-center mono text-caption"
            style={{
              gap: 4,
              padding: "var(--sp-0_5) var(--sp-1_5)",
              border: "var(--hairline) solid var(--accent)",
              borderRadius: "var(--radius-chip)",
              background: "color-mix(in oklch, var(--accent) 12%, transparent)",
              color: "var(--fg)",
            }}
          >
            {agentName(agentId)}
            <button
              type="button"
              onClick={() => onChange(selected.filter((x) => x !== agentId))}
              className="inline-flex items-center"
              style={{
                background: "transparent",
                border: "none",
                cursor: "pointer",
                color: "var(--fg-3)",
                padding: 0,
              }}
              aria-label={`Remove ${agentName(agentId)}`}
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          value={query}
          onChange={(ev) => {
            setQuery(ev.target.value);
            if (!open) setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={selected.length === 0 ? placeholder : ""}
          role="combobox"
          aria-controls={popoverId}
          aria-expanded={open}
          aria-haspopup="listbox"
          className="outline-none text-body"
          style={{
            flex: 1,
            minWidth: 80,
            padding: "var(--sp-0_5) 0",
            background: "transparent",
            border: 0,
            color: "var(--fg)",
          }}
        />
        <button
          type="button"
          onClick={() => {
            setOpen((v) => !v);
            inputRef.current?.focus();
          }}
          className="inline-flex items-center shrink-0"
          style={{
            padding: 2,
            background: "transparent",
            border: "none",
            color: "var(--fg-3)",
            cursor: "pointer",
          }}
          aria-label="Toggle target picker"
        >
          <ChevronDown className="h-3 w-3" />
        </button>
      </div>

      {open && (
        <div
          id={popoverId}
          role="listbox"
          aria-multiselectable={multi}
          className="absolute z-30"
          style={{
            top: "calc(100% + var(--sp-0_5))",
            left: 0,
            right: 0,
            maxHeight: 240,
            overflowY: "auto",
            background: "var(--bg-raised)",
            border: "var(--hairline) solid var(--border)",
            borderRadius: "var(--radius-input)",
            boxShadow: "var(--shadow-md)",
          }}
        >
          {filtered.length === 0 ? (
            <div className="text-body" style={{ padding: "var(--sp-2) var(--sp-2_5)", color: "var(--fg-3)" }}>
              No matches
            </div>
          ) : (
            filtered.map((c, idx) => {
              const active = idx === highlight;
              return (
                <button
                  key={c.agentId}
                  type="button"
                  role="option"
                  aria-selected={selected.includes(c.agentId)}
                  onMouseEnter={() => setHighlight(idx)}
                  onClick={() => toggle(c.agentId)}
                  className={cn("w-full text-left grid items-center")}
                  style={{
                    gridTemplateColumns: "var(--sp-3) 1fr auto",
                    columnGap: 8,
                    padding: "var(--sp-1_5) var(--sp-2_5)",
                    background: active ? "var(--bg-active)" : "transparent",
                    borderLeft: `var(--hairline-bold) solid ${active ? "var(--accent)" : "transparent"}`,
                    cursor: "pointer",
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: c.online ? "var(--state-working)" : "var(--fg-4)",
                      display: "inline-block",
                    }}
                  />
                  <span className="min-w-0 flex items-center" style={{ gap: 6 }}>
                    <span className="mono truncate text-body" style={{ color: "var(--fg)" }}>
                      {c.displayName}
                    </span>
                    {c.type === "human" && (
                      <span
                        className="mono uppercase text-eyebrow"
                        style={{
                          padding: "var(--hairline) var(--sp-1_25)",
                          borderRadius: 2,
                          color: "var(--accent)",
                          background: "color-mix(in oklch, var(--accent) 15%, transparent)",
                        }}
                      >
                        human
                      </span>
                    )}
                  </span>
                  {c.type && c.type !== "human" && (
                    <span className="mono text-caption" style={{ color: "var(--fg-4)" }}>
                      {c.type === "personal_assistant" ? "PA" : "agent"}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Resolve the default initial target for a draft chat. Per the design
 * doc: most-recently-used agent if any, else a `personal_assistant`
 * fallback. The "MRU" signal isn't durable yet — we use the activity
 * overview's `runtimeUpdatedAt` as a proxy.
 */
export function pickDefaultTarget(candidates: TargetCandidate[], activity: RuntimeAgent[]): string | null {
  const ids = new Set(candidates.map((c) => c.agentId));
  const mru = [...activity]
    .filter((a) => ids.has(a.agentId) && a.runtimeUpdatedAt)
    .sort((a, b) => (b.runtimeUpdatedAt ?? "").localeCompare(a.runtimeUpdatedAt ?? ""))[0];
  if (mru) return mru.agentId;
  const pa = candidates.find((c) => c.type === "personal_assistant");
  if (pa) return pa.agentId;
  return candidates[0]?.agentId ?? null;
}
