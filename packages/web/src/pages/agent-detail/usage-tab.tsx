import type { UsageAgentSummary, UsageTurnRow } from "@first-tree/shared";
import { useQuery } from "@tanstack/react-query";
import { type CSSProperties, type ReactElement, type ReactNode, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { getAgentUsageSummary, getAgentUsageTurns } from "../../api/usage.js";
import { Section } from "../../components/ui/section.js";
import { formatCompactCount, formatRelative } from "../../lib/utils.js";
import { useAgentDetailContext } from "./layout-context.js";

const ACTIVITY_GRID_DAYS = 90;
const RECENT_TURNS_LIMIT = 10;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// Calendar columns are Sunday-first (row index 0 = Sunday, matching JS
// Date.getUTCDay()). GitHub's contribution graph convention labels rows
// 1/3/5 — Mon, Wed, Fri — and leaves Sun/Tue/Thu/Sat blank.
const WEEKDAY_RAIL: readonly string[] = ["", "Mon", "", "Wed", "", "Fri", ""];

/**
 * Agent profile Usage tab — the deep view onto one agent's token usage.
 * Two blocks, both always-on (no window selector):
 *   1. Activity (last 90 days) — GitHub-style contribution calendar with
 *      hover tooltips, paired with a 2×2 stats panel.
 *   2. Recent turns (30d)     — last 10 turns with model chips + per-row
 *      volume bar; deep-links each row to its source chat.
 *
 * Summary + turns run in parallel. The summary endpoint always returns a
 * trailing-90d `daily` series regardless of the `from` window, so the 30d
 * call here is just a stable, server-cached key.
 */
export function UsageTab(): ReactElement {
  const ctx = useAgentDetailContext();

  const summaryQuery = useQuery({
    queryKey: ["usage-summary", ctx.agent.uuid, "30d"],
    queryFn: () => getAgentUsageSummary(ctx.agent.uuid, "30d"),
    enabled: !ctx.isHuman,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const turnsQuery = useQuery({
    queryKey: ["usage-turns", ctx.agent.uuid, "30d", "first10"],
    queryFn: () => getAgentUsageTurns(ctx.agent.uuid, { window: "30d", limit: RECENT_TURNS_LIMIT }),
    enabled: !ctx.isHuman,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  if (ctx.isHuman) {
    return (
      <Section title="Usage">
        <UsagePlaceholder>
          Token usage is only tracked for agent-type accounts. This profile represents a human member and does not run
          model turns.
        </UsagePlaceholder>
      </Section>
    );
  }

  return (
    <>
      <ActivityBlock data={summaryQuery.data} isLoading={summaryQuery.isLoading} isError={summaryQuery.isError} />
      <RecentTurnsBlock
        rows={turnsQuery.data?.rows ?? []}
        isLoading={turnsQuery.isLoading}
        isError={turnsQuery.isError}
      />
    </>
  );
}

/* ============================================================================
   Activity
   ========================================================================== */

type DayBucket = { date: string; weekday: number; month: number; day: number; year: number; tokens: number };

function ActivityBlock({
  data,
  isLoading,
  isError,
}: {
  data: UsageAgentSummary | undefined;
  isLoading: boolean;
  isError: boolean;
}): ReactElement {
  return (
    <Section
      title={
        <>
          Activity{" "}
          <span className="font-normal" style={{ color: "var(--fg-4)" }}>
            · last 90 days
          </span>
        </>
      }
      description="Daily input tokens. Darker cells mean more usage."
      action={<DensityLegend />}
    >
      {isError ? (
        <UsagePlaceholder tone="error">Failed to load activity.</UsagePlaceholder>
      ) : isLoading ? (
        <UsagePlaceholder>Loading activity…</UsagePlaceholder>
      ) : (
        <ActivityBody summary={data} />
      )}
    </Section>
  );
}

function DensityLegend(): ReactElement {
  return (
    <span className="usage-cal-legend text-caption">
      Less
      <span className="usage-cal-legend-cell" style={{ background: "var(--lvl0)" }} />
      <span className="usage-cal-legend-cell" style={{ background: "var(--lvl1)" }} />
      <span className="usage-cal-legend-cell" style={{ background: "var(--lvl2)" }} />
      <span className="usage-cal-legend-cell" style={{ background: "var(--lvl3)" }} />
      <span className="usage-cal-legend-cell" style={{ background: "var(--lvl4)" }} />
      More
    </span>
  );
}

function ActivityBody({ summary }: { summary: UsageAgentSummary | undefined }): ReactElement {
  const days = useMemo(() => buildDays(summary?.daily), [summary?.daily]);
  const columns = useMemo(() => buildColumns(days), [days]);
  const max = Math.max(1, ...days.map((d) => d.tokens));
  const stats = useMemo(() => computeStats(days), [days]);
  const [hover, setHover] = useState<{ d: DayBucket; x: number; y: number } | null>(null);

  return (
    <div className="usage-activity-row">
      <div className="usage-cal-shell">
        <div className="usage-cal-inner">
          {/* Weekday rail — Mon / Wed / Fri labels, the rest are empty spacers
              that keep the row geometry aligned with the cell grid. */}
          <div className="usage-cal-weekday-rail">
            {WEEKDAY_RAIL.map((label, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed 7-row rail, slot identity IS the index.
              <span key={i} className="usage-cal-weekday-cell text-caption">
                {label}
              </span>
            ))}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <MonthsRow columns={columns} />
            <div className="usage-cal-grid">
              {columns.map((col, ci) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: column position is the column's identity in this fixed-geometry grid.
                <div key={ci} className="usage-cal-col">
                  {col.map((d, ri) => (
                    <Cell
                      // biome-ignore lint/suspicious/noArrayIndexKey: weekday row position is the cell's identity in its column.
                      key={ri}
                      day={d}
                      max={max}
                      onEnter={(e) => {
                        if (!d) return;
                        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                        setHover({ d, x: r.left + r.width / 2, y: r.top });
                      }}
                      onLeave={() => setHover(null)}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      <ActivityStatsPanel stats={stats} />
      {hover && <CellTooltip day={hover.d} anchorX={hover.x} anchorY={hover.y} />}
    </div>
  );
}

function MonthsRow({ columns }: { columns: (DayBucket | null)[][] }): ReactElement {
  let lastMonth = -1;
  return (
    <div className="usage-cal-months">
      {columns.map((col, i) => {
        const first = col.find((d): d is DayBucket => d != null);
        const showLabel = first != null && first.month !== lastMonth;
        if (showLabel && first) lastMonth = first.month;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: column position is the slot's identity in this fixed-geometry header.
          <span key={i} className="usage-cal-month-slot text-caption">
            {showLabel && first ? MONTHS[first.month] : ""}
          </span>
        );
      })}
    </div>
  );
}

function Cell({
  day,
  max,
  onEnter,
  onLeave,
}: {
  day: DayBucket | null;
  max: number;
  onEnter: (e: React.MouseEvent) => void;
  onLeave: () => void;
}): ReactElement {
  if (!day) {
    return <span aria-hidden="true" className="usage-cal-cell usage-cal-cell-empty" />;
  }
  const b = bucket(day.tokens, max);
  const colors = ["var(--lvl0)", "var(--lvl1)", "var(--lvl2)", "var(--lvl3)", "var(--lvl4)"];
  return (
    <span
      role="img"
      aria-label={`${WEEKDAYS[day.weekday]} ${MONTHS[day.month]} ${day.day}: ${
        day.tokens > 0 ? `${formatCompactCount(day.tokens)} input tokens` : "no activity"
      }`}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      className="usage-cal-cell"
      style={{ background: colors[b] }}
    />
  );
}

function CellTooltip({ day, anchorX, anchorY }: { day: DayBucket; anchorX: number; anchorY: number }): ReactElement {
  const label = `${WEEKDAYS[day.weekday]} · ${MONTHS[day.month]} ${day.day}, ${day.year}`;
  const value = day.tokens > 0 ? `${formatCompactCount(day.tokens)} input tokens` : "No activity";
  return (
    <div role="tooltip" className="usage-cal-tooltip" style={{ left: anchorX, top: anchorY }}>
      <div className="text-eyebrow mono" style={{ color: "var(--fg-3)" }}>
        {label}
      </div>
      <div className="usage-cal-tooltip-value text-body mono font-semibold">{value}</div>
    </div>
  );
}

function ActivityStatsPanel({
  stats,
}: {
  stats: { activeDays: number; avgPerDay: number; peak: DayBucket | null; streak: number };
}): ReactElement {
  const peakLabel =
    stats.peak && stats.peak.tokens > 0
      ? `${MONTHS[stats.peak.month]} ${stats.peak.day} · ${formatCompactCount(stats.peak.tokens)}`
      : "—";
  return (
    <div className="usage-stats-panel">
      <StatTile
        label="Active days"
        value={
          <>
            {stats.activeDays}
            <span className="font-normal" style={{ color: "var(--fg-4)" }}>
              {` / ${ACTIVITY_GRID_DAYS}`}
            </span>
          </>
        }
      />
      <StatTile label="Avg input / day" value={formatCompactCount(stats.avgPerDay)} mono />
      <StatTile label="Peak day" value={peakLabel} mono />
      <StatTile
        label="Current streak"
        value={
          <>
            {stats.streak}
            <span className="font-normal" style={{ color: "var(--fg-4)" }}>
              {" "}
              {stats.streak === 1 ? "day" : "days"}
            </span>
          </>
        }
      />
    </div>
  );
}

function StatTile({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }): ReactElement {
  return (
    <div className="usage-stats-tile">
      <div className="usage-stats-tile-label text-caption">{label}</div>
      <div className={`usage-stats-tile-value text-subtitle${mono ? " mono" : ""}`}>{value}</div>
    </div>
  );
}

/* ============================================================================
   Recent turns
   ========================================================================== */

function RecentTurnsBlock({
  rows,
  isLoading,
  isError,
}: {
  rows: UsageTurnRow[];
  isLoading: boolean;
  isError: boolean;
}): ReactElement {
  return (
    <Section title="Recent turns" description={`Last ${RECENT_TURNS_LIMIT} turns from the last 30 days.`}>
      {isError ? (
        <UsagePlaceholder tone="error">Failed to load recent turns.</UsagePlaceholder>
      ) : isLoading ? (
        <UsagePlaceholder>Loading recent turns…</UsagePlaceholder>
      ) : rows.length === 0 ? (
        <UsagePlaceholder>No turns recorded in the last 30 days.</UsagePlaceholder>
      ) : (
        <TurnsTable rows={rows} />
      )}
    </Section>
  );
}

function TurnsTable({ rows }: { rows: UsageTurnRow[] }): ReactElement {
  const navigate = useNavigate();
  const totalFor = (r: UsageTurnRow) => r.inputTokens + r.cachedInputTokens + r.outputTokens;
  const max = Math.max(1, ...rows.map(totalFor));
  return (
    <div className="usage-turn-scroll">
      <table className="usage-turn-table w-full" style={{ borderCollapse: "collapse", marginTop: "var(--sp-1)" }}>
        <thead>
          <tr className="text-eyebrow" style={{ color: "var(--fg-4)" }}>
            <th style={thStyle("left")}>When</th>
            <th style={thStyle("left")}>Chat</th>
            <th style={thStyle("left")}>Model</th>
            <th style={thStyle("right")}>Input</th>
            <th style={thStyle("right")}>Cached</th>
            <th style={thStyle("right")}>Output</th>
            <th style={{ ...thStyle("left"), width: "var(--sp-20)" }}>Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const total = totalFor(r);
            return (
              <tr key={`${r.chatId}:${r.seq}`} className="usage-turn-row">
                <td className="text-body" style={{ color: "var(--fg-3)", whiteSpace: "nowrap" }}>
                  {formatRelative(r.createdAt)}
                </td>
                <td>
                  {r.chatTitle ? (
                    <button
                      type="button"
                      onClick={() => navigate(`/?chat=${encodeURIComponent(r.chatId)}`)}
                      className="text-body font-medium"
                      style={{
                        background: "transparent",
                        border: 0,
                        padding: 0,
                        cursor: "pointer",
                        color: "var(--fg)",
                        textAlign: "left",
                      }}
                    >
                      {r.chatTitle}
                    </button>
                  ) : (
                    <span className="text-body" style={{ color: "var(--fg-4)" }}>
                      private chat
                    </span>
                  )}
                </td>
                <td>
                  <ModelChip provider={r.provider} model={r.model} />
                </td>
                <td className="mono text-body" style={{ textAlign: "right", color: "var(--fg-2)" }}>
                  {formatCompactCount(r.inputTokens)}
                </td>
                <td className="mono text-body" style={{ textAlign: "right", color: "var(--fg-3)" }}>
                  {formatCompactCount(r.cachedInputTokens)}
                </td>
                <td className="mono text-body" style={{ textAlign: "right", color: "var(--fg-2)" }}>
                  {formatCompactCount(r.outputTokens)}
                </td>
                <td>
                  <div className="usage-turn-total-cell">
                    <span className="mono text-body">{formatCompactCount(total)}</span>
                    <div
                      role="img"
                      className="usage-turn-volbar"
                      aria-label={`${formatCompactCount(total)} tokens this turn`}
                    >
                      <span style={{ width: `${(total / max) * 100}%` }} />
                    </div>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function thStyle(align: "left" | "right"): CSSProperties {
  return { textAlign: align };
}

function ModelChip({ provider, model }: { provider: string; model: string }): ReactElement {
  return (
    <span className="usage-model-chip mono text-caption">
      {provider}/{model}
    </span>
  );
}

/* ============================================================================
   Helpers
   ========================================================================== */

function buildDays(daily: UsageAgentSummary["daily"] | undefined): DayBucket[] {
  // `daily[].date` is YYYY-MM-DD in UTC (schema). Iterate, label, and join in
  // UTC consistently — local-tz Date methods would shift weekday/date by ±1
  // half the day in non-UTC zones and silently miss the join key.
  const byDate = new Map<string, number>();
  for (const d of daily ?? []) byDate.set(d.date, d.inputTokens);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const days: DayBucket[] = [];
  for (let i = ACTIVITY_GRID_DAYS - 1; i >= 0; i--) {
    const dt = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
    const iso = dt.toISOString().slice(0, 10);
    days.push({
      date: iso,
      weekday: dt.getUTCDay(),
      month: dt.getUTCMonth(),
      day: dt.getUTCDate(),
      year: dt.getUTCFullYear(),
      tokens: byDate.get(iso) ?? 0,
    });
  }
  return days;
}

function buildColumns(days: DayBucket[]): (DayBucket | null)[][] {
  const first = days[0];
  if (!first) return [];
  const cols: (DayBucket | null)[][] = [];
  // Pad the first column so its first cell sits in the correct weekday row.
  let col: (DayBucket | null)[] = new Array(first.weekday).fill(null);
  for (const d of days) {
    col[d.weekday] = d;
    if (d.weekday === 6) {
      cols.push(col);
      col = new Array(7).fill(null);
    }
  }
  if (col.some((x) => x != null)) {
    while (col.length < 7) col.push(null);
    cols.push(col);
  }
  return cols;
}

function bucket(tokens: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (tokens <= 0) return 0;
  const r = Math.log10(1 + tokens) / Math.log10(1 + max);
  if (r < 0.25) return 1;
  if (r < 0.5) return 2;
  if (r < 0.75) return 3;
  return 4;
}

function computeStats(days: DayBucket[]): {
  activeDays: number;
  avgPerDay: number;
  peak: DayBucket | null;
  streak: number;
} {
  const activeDays = days.filter((d) => d.tokens > 0).length;
  const total = days.reduce((acc, d) => acc + d.tokens, 0);
  const avgPerDay = days.length > 0 ? Math.round(total / days.length) : 0;
  const seed = days[0];
  const peak = seed ? days.reduce((a, d) => (d.tokens > a.tokens ? d : a), seed) : null;
  let streak = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    const d = days[i];
    if (d && d.tokens > 0) streak++;
    else break;
  }
  return { activeDays, avgPerDay, peak, streak };
}

/* ============================================================================
   Misc
   ========================================================================== */

function UsagePlaceholder({ children, tone }: { children: ReactNode; tone?: "error" }): ReactElement {
  return (
    <p className="usage-placeholder text-label" data-tone={tone}>
      {children}
    </p>
  );
}
