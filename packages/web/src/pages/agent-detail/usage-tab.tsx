import type { UsageAgentSummary, UsageTurnRow } from "@first-tree/shared";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { type ReactElement, useState } from "react";
import { useNavigate } from "react-router";
import { getAgentUsageSummary, getAgentUsageTurns, type UsageWindow, windowToDays } from "../../api/usage.js";
import { Section } from "../../components/ui/section.js";
import { formatCompactCount, formatRelative } from "../../lib/utils.js";
import { useAgentDetailContext } from "./layout-context.js";

const ACTIVITY_GRID_DAYS = 90;

/**
 * Agent profile Usage tab — the deep view onto one agent's token usage.
 * Three blocks:
 *   1. KPI strip      — window totals (driven by 7d/30d selector)
 *   2. Activity grid  — fixed 90d daily density (always-on, ignores selector)
 *   3. Recent turns   — paginated per-turn detail with deep-link back to chat
 */
export function UsageTab(): ReactElement {
  const ctx = useAgentDetailContext();
  const [window, setWindow] = useState<UsageWindow>("30d");

  if (ctx.isHuman) {
    return (
      <Section title="Token Usage">
        <p className="text-body" style={{ color: "var(--fg-3)" }}>
          Token usage is only tracked for agent-type accounts. This profile represents a human member and does not run
          model turns.
        </p>
      </Section>
    );
  }

  return (
    <>
      <SummaryBlock agentId={ctx.agent.uuid} window={window} onWindowChange={setWindow} />
      <ActivityGridBlock agentId={ctx.agent.uuid} />
      <RecentTurnsBlock agentId={ctx.agent.uuid} window={window} />
    </>
  );
}

function SummaryBlock({
  agentId,
  window,
  onWindowChange,
}: {
  agentId: string;
  window: UsageWindow;
  onWindowChange: (next: UsageWindow) => void;
}): ReactElement {
  const summaryQuery = useQuery({
    queryKey: ["usage-summary", agentId, window],
    queryFn: () => getAgentUsageSummary(agentId, window),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const totals = summaryQuery.data?.totals;
  const totalTokens = totals ? totals.inputTokens + totals.cachedInputTokens + totals.outputTokens : null;

  return (
    <Section title="Token Usage" action={<WindowPicker window={window} onChange={onWindowChange} />}>
      <div className="grid" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: "var(--sp-4)" }}>
        <Kpi label={`Tokens (${window})`} value={formatCompactCount(totalTokens)} loading={summaryQuery.isLoading} />
        <Kpi label="Turns" value={formatCompactCount(totals?.turns ?? null)} loading={summaryQuery.isLoading} />
        <Kpi label="Chats" value={formatCompactCount(totals?.chats ?? null)} loading={summaryQuery.isLoading} />
        <Kpi label="Last active" value={formatRelative(totals?.lastUsageAt ?? null)} loading={summaryQuery.isLoading} />
      </div>
      {totals?.inputTokens !== undefined && totalTokens !== null && totalTokens > 0 && (
        <p className="text-caption" style={{ color: "var(--fg-4)", marginTop: "var(--sp-3)" }}>
          Input {formatCompactCount(totals.inputTokens)} · Cached {formatCompactCount(totals.cachedInputTokens)} ·
          Output {formatCompactCount(totals.outputTokens)}
        </p>
      )}
    </Section>
  );
}

function Kpi({ label, value, loading }: { label: string; value: string; loading: boolean }): ReactElement {
  return (
    <div>
      <div className="text-caption" style={{ color: "var(--fg-4)" }}>
        {label}
      </div>
      <div className="text-h3 mono" style={{ color: "var(--fg-2)", marginTop: "var(--sp-1)" }}>
        {loading ? "…" : value}
      </div>
    </div>
  );
}

function WindowPicker({
  window,
  onChange,
}: {
  window: UsageWindow;
  onChange: (next: UsageWindow) => void;
}): ReactElement {
  const base = "px-2 py-0_5 text-caption font-semibold";
  const baseStyle = { background: "transparent", border: 0, cursor: "pointer", color: "var(--fg-3)" };
  const activeStyle = { ...baseStyle, color: "var(--fg-2)", background: "var(--bg-hover)" };
  return (
    <span
      className="inline-flex items-center"
      style={{ gap: "var(--hairline)", border: "var(--hairline) solid var(--border)", padding: "var(--hairline)" }}
    >
      <button
        type="button"
        className={base}
        onClick={() => onChange("7d")}
        style={window === "7d" ? activeStyle : baseStyle}
      >
        7d
      </button>
      <button
        type="button"
        className={base}
        onClick={() => onChange("30d")}
        style={window === "30d" ? activeStyle : baseStyle}
      >
        30d
      </button>
    </span>
  );
}

function ActivityGridBlock({ agentId }: { agentId: string }): ReactElement {
  // Fixed-90d query that does not change with the KPI window picker —
  // the grid is the "long-horizon density" view; if it followed the
  // selector to 7d, 83 of 90 cells would always be grey and the grid
  // would stop conveying anything.
  const summaryQuery = useQuery({
    queryKey: ["usage-summary", agentId, "30d"],
    queryFn: () => getAgentUsageSummary(agentId, "30d"),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  return (
    <Section title="Activity (last 90 days)">
      <ActivityGrid summary={summaryQuery.data} loading={summaryQuery.isLoading} />
    </Section>
  );
}

/**
 * 90-day daily-density grid. Buckets daily input-token totals into 5 levels;
 * cells with no events render as the lowest level (effectively empty). The
 * server returns only days with activity, so we backfill the missing days
 * on the client to keep the grid's geometry stable regardless of activity.
 */
function ActivityGrid({
  summary,
  loading,
}: {
  summary: UsageAgentSummary | undefined;
  loading: boolean;
}): ReactElement {
  if (loading) {
    return (
      <p className="text-caption" style={{ color: "var(--fg-4)" }}>
        Loading…
      </p>
    );
  }
  const byDate = new Map<string, number>();
  for (const d of summary?.daily ?? []) byDate.set(d.date, d.inputTokens);
  const today = new Date();
  const days: { date: string; tokens: number }[] = [];
  for (let i = ACTIVITY_GRID_DAYS - 1; i >= 0; i--) {
    const dt = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
    const iso = dt.toISOString().slice(0, 10);
    days.push({ date: iso, tokens: byDate.get(iso) ?? 0 });
  }
  const max = Math.max(1, ...days.map((d) => d.tokens));
  // Five buckets (0..4). 0 reserved for zero; 1..4 split log-scaled max.
  function bucket(t: number): 0 | 1 | 2 | 3 | 4 {
    if (t <= 0) return 0;
    const r = Math.log10(1 + t) / Math.log10(1 + max);
    if (r < 0.25) return 1;
    if (r < 0.5) return 2;
    if (r < 0.75) return 3;
    return 4;
  }
  const colors: Record<0 | 1 | 2 | 3 | 4, string> = {
    0: "var(--bg-sunken)",
    1: "var(--accent-bg)",
    2: "color-mix(in oklch, var(--accent) 35%, var(--bg-sunken))",
    3: "color-mix(in oklch, var(--accent) 65%, var(--bg-sunken))",
    4: "var(--accent)",
  };
  return (
    <div>
      <div
        className="grid"
        style={{
          gridTemplateColumns: `repeat(${ACTIVITY_GRID_DAYS}, minmax(0, 1fr))`,
          gap: "var(--hairline)",
        }}
      >
        {days.map((d) => {
          const b = bucket(d.tokens);
          return (
            <span
              key={d.date}
              title={`${d.date} · ${formatCompactCount(d.tokens)} input tokens`}
              style={{
                background: colors[b],
                height: "var(--sp-3)",
                borderRadius: "var(--hairline)",
                display: "block",
              }}
            />
          );
        })}
      </div>
      <p className="text-caption" style={{ color: "var(--fg-4)", marginTop: "var(--sp-2)" }}>
        Darker = more input tokens that day · Data since 2026-05-28
      </p>
    </div>
  );
}

function RecentTurnsBlock({ agentId, window }: { agentId: string; window: UsageWindow }): ReactElement {
  const turnsQuery = useInfiniteQuery({
    queryKey: ["usage-turns", agentId, window],
    queryFn: ({ pageParam }) => getAgentUsageTurns(agentId, { window, cursor: pageParam ?? null, limit: 50 }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const rows = turnsQuery.data?.pages.flatMap((p) => p.rows) ?? [];
  return (
    <Section
      title={`Recent turns (${window})`}
      action={
        turnsQuery.hasNextPage ? (
          <button
            type="button"
            onClick={() => void turnsQuery.fetchNextPage()}
            className="text-caption font-semibold"
            style={{
              background: "transparent",
              border: 0,
              cursor: "pointer",
              color: "var(--accent)",
            }}
            disabled={turnsQuery.isFetchingNextPage}
          >
            {turnsQuery.isFetchingNextPage ? "Loading…" : "Load more"}
          </button>
        ) : null
      }
    >
      {turnsQuery.isLoading ? (
        <p className="text-caption" style={{ color: "var(--fg-4)" }}>
          Loading…
        </p>
      ) : rows.length === 0 ? (
        <p className="text-caption" style={{ color: "var(--fg-4)" }}>
          No turns in the last {windowToDays(window)} days.
        </p>
      ) : (
        <TurnsTable rows={rows} />
      )}
    </Section>
  );
}

function TurnsTable({ rows }: { rows: UsageTurnRow[] }): ReactElement {
  const navigate = useNavigate();
  return (
    <table className="w-full text-caption" style={{ borderCollapse: "collapse" }}>
      <thead>
        <tr className="font-semibold" style={{ color: "var(--fg-4)" }}>
          <th style={{ textAlign: "left", padding: "var(--sp-2)" }}>When</th>
          <th style={{ textAlign: "left", padding: "var(--sp-2)" }}>Chat</th>
          <th style={{ textAlign: "right", padding: "var(--sp-2)" }}>Input</th>
          <th style={{ textAlign: "right", padding: "var(--sp-2)" }}>Cached</th>
          <th style={{ textAlign: "right", padding: "var(--sp-2)" }}>Output</th>
          <th style={{ textAlign: "left", padding: "var(--sp-2)" }}>Model</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.chatId}:${r.seq}`} style={{ borderTop: "var(--hairline) solid var(--border-faint)" }}>
            <td style={{ padding: "var(--sp-2)", color: "var(--fg-3)" }}>{formatRelative(r.createdAt)}</td>
            <td style={{ padding: "var(--sp-2)" }}>
              {r.chatTitle ? (
                <button
                  type="button"
                  onClick={() => navigate(`/?chat=${encodeURIComponent(r.chatId)}`)}
                  className="font-medium"
                  style={{
                    background: "transparent",
                    border: 0,
                    cursor: "pointer",
                    color: "var(--accent)",
                    padding: 0,
                  }}
                >
                  {r.chatTitle}
                </button>
              ) : (
                <span style={{ color: "var(--fg-4)" }}>private chat</span>
              )}
            </td>
            <td className="mono" style={{ padding: "var(--sp-2)", textAlign: "right" }}>
              {formatCompactCount(r.inputTokens)}
            </td>
            <td className="mono" style={{ padding: "var(--sp-2)", textAlign: "right", color: "var(--fg-3)" }}>
              {formatCompactCount(r.cachedInputTokens)}
            </td>
            <td className="mono" style={{ padding: "var(--sp-2)", textAlign: "right" }}>
              {formatCompactCount(r.outputTokens)}
            </td>
            <td className="mono" style={{ padding: "var(--sp-2)", color: "var(--fg-3)" }}>
              {r.provider}/{r.model}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
