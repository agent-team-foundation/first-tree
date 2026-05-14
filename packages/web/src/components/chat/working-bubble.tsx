/**
 * WorkingBubble — collapsible group of in-progress tool_call / thinking
 * events from one agent's active turn, rendered inline in the chat
 * timeline.
 *
 * Folded (group-chat default): a single mono row indistinguishable from
 * the legacy in-line ToolCallStatusRow / ThinkingRow, plus a trailing
 * chevron.
 *
 * Expanded (direct-chat default): the same head row, the full event
 * history underneath, and a compact meta line with counts + elapsed.
 *
 * No border / background / radius — state is conveyed solely through
 * the leading status dot. The bubble doesn't model "done" itself; when
 * `filterEventsForTimeline` drops the events after `turn_end`, the
 * parent omits the workgroup entry and the bubble simply unmounts.
 */

import { useState } from "react";
import { asToolCallPayload, type SessionEventRow } from "../../api/sessions.js";

type WorkingBubbleProps = {
  /**
   * tool_call and thinking events for one active turn, in seq-ascending
   * order. Errors are intentionally excluded — they're rendered as
   * their own ErrorRow upstream so failures stay visible regardless of
   * this bubble's open/closed state.
   */
  events: SessionEventRow[];
  /**
   * Direct chats pass `true` (single-agent context — show everything),
   * group chats pass `false` (quiet by default).
   */
  defaultOpen: boolean;
};

function formatDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

function formatElapsedSec(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}m${s.toString().padStart(2, "0")}s`;
}

function previewArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args);
  } catch {
    return "…";
  }
}

function ToolCallLine({ event }: { event: SessionEventRow }) {
  const payload = asToolCallPayload(event.payload);
  if (!payload) return null;
  const isErr = payload.status === "error";
  const isPending = payload.status === "pending";
  const color = isErr ? "var(--state-error)" : isPending ? "var(--state-blocked)" : "var(--fg-3)";
  const verb = isErr ? "failed" : isPending ? "using" : "used";
  return (
    <div
      className="mono flex items-center text-label"
      style={{
        gap: 8,
        padding: "var(--sp-0_5) var(--sp-2)",
        color: "var(--fg-3)",
      }}
    >
      {isPending ? (
        <span
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: color,
            animation: "heartbeat-pulse 1.2s ease-in-out infinite",
            flexShrink: 0,
            marginTop: 5,
          }}
        />
      ) : (
        <span aria-hidden style={{ color, flexShrink: 0 }}>
          {isErr ? "⚠" : "↳"}
        </span>
      )}
      <span
        className="flex items-baseline"
        style={{ color: "var(--fg-3)", minWidth: 0, flex: 1 }}
        title={payload.args !== undefined && payload.args !== null ? previewArgs(payload.args) : undefined}
      >
        <span style={{ whiteSpace: "nowrap", flexShrink: 0 }}>
          {verb} <span style={{ color: "var(--fg-2)" }}>{payload.name}</span>
        </span>
        {payload.args !== undefined && payload.args !== null ? (
          <span className="truncate" style={{ color: "var(--fg-4)", minWidth: 0, flex: 1 }}>
            ({previewArgs(payload.args)})
          </span>
        ) : null}
        {payload.durationMs !== undefined && !isPending ? (
          <span
            className="text-caption"
            style={{
              color: "var(--fg-4)",
              marginLeft: 6,
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            · {formatDuration(payload.durationMs)}
          </span>
        ) : null}
      </span>
    </div>
  );
}

function formatClockTime(iso: string): string {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-GB", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("month")}/${get("day")} ${get("hour")}:${get("minute")}`;
}

function ThinkingLine({ event }: { event: SessionEventRow }) {
  return (
    <div
      className="mono flex items-center text-label"
      style={{
        gap: 8,
        padding: "var(--sp-0_5) var(--sp-2)",
        color: "var(--fg-3)",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: "var(--accent)",
          animation: "heartbeat-pulse 1.2s ease-in-out infinite",
          flexShrink: 0,
        }}
      />
      <span style={{ color: "var(--fg-3)" }}>thinking…</span>
      <span className="mono text-caption" style={{ color: "var(--fg-4)" }}>
        {formatClockTime(event.createdAt)}
      </span>
    </div>
  );
}

function renderLine(event: SessionEventRow): React.ReactNode {
  if (event.kind === "tool_call") return <ToolCallLine event={event} />;
  if (event.kind === "thinking") return <ThinkingLine event={event} />;
  return null;
}

function summarize(events: SessionEventRow[]): { toolCalls: number; thinkings: number; elapsedSec: number } {
  let toolCalls = 0;
  let thinkings = 0;
  for (const e of events) {
    if (e.kind === "tool_call") toolCalls += 1;
    if (e.kind === "thinking") thinkings += 1;
  }
  const first = events[0];
  const elapsedSec = first ? Math.max(0, Math.round((Date.now() - new Date(first.createdAt).getTime()) / 1000)) : 0;
  return { toolCalls, thinkings, elapsedSec };
}

export function WorkingBubble({ events, defaultOpen }: WorkingBubbleProps) {
  // `open` is local state so the user's manual toggle survives incoming
  // events. Resetting only happens on remount, which the parent triggers
  // when `turn_end` arrives and the workgroup entry disappears.
  const [open, setOpen] = useState<boolean>(defaultOpen);

  // Head row = the latest event in the turn. Folded chats see only this
  // row, which matches the legacy in-line presentation pixel-for-pixel.
  const latest = events[events.length - 1];
  if (!latest) return null;
  const { toolCalls, thinkings, elapsedSec } = summarize(events);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          background: "transparent",
          border: 0,
          padding: 0,
          cursor: "pointer",
          minWidth: 0,
        }}
        aria-expanded={open}
        aria-label={open ? "Collapse working details" : "Expand working details"}
      >
        <span style={{ flex: 1, minWidth: 0 }}>{renderLine(latest)}</span>
        <span
          aria-hidden
          className="text-caption"
          style={{
            color: "var(--fg-4)",
            transform: open ? "rotate(180deg)" : "none",
            transition: "transform 150ms ease",
            marginRight: "var(--sp-1_5)",
            flexShrink: 0,
            lineHeight: 1,
          }}
        >
          ▾
        </span>
      </button>

      {open ? (
        <div>
          {events.map((e) => (
            <div key={e.id}>{renderLine(e)}</div>
          ))}
          <div
            className="mono text-caption"
            style={{
              color: "var(--fg-4)",
              padding: "var(--sp-0_5) var(--sp-2) 0 var(--sp-4)",
            }}
          >
            {toolCalls} {toolCalls === 1 ? "tool" : "tools"} · {thinkings} thinking · {formatElapsedSec(elapsedSec)}
          </div>
        </div>
      ) : null}
    </div>
  );
}
