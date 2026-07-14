/**
 * WorkingTurn — the inline representation of an agent's active turn in the chat
 * timeline. It holds the agent's latest streamed narration (the body) plus a
 * de-emphasized process lane of tool_call / thinking events. Borderless — no
 * card chrome; the avatar/header + whitespace bind the block like a message row.
 *
 * It exists only while the turn runs: `filterEventsForTimeline` drops the
 * turn's transient events once `turn_end` arrives, the parent omits the
 * workgroup entry, and this unmounts — the final answer then arrives as a
 * regular chat message. So "mounted" ⇔ "this agent is working".
 *
 * "Working" is conveyed by the header (cyan label + an enlarged pulsing dot + a live
 * elapsed counter that ticks every second, so it reads as alive even while the
 * body and process lane sit still) — not by any border, fill, or card chrome.
 */

import { stripShellCommandDisplayWrapper } from "@first-tree/shared";
import { useEffect, useState } from "react";
import {
  asAssistantTextPayload,
  asToolCallPayload,
  type SessionEventRow,
  type ToolCallEventPayload,
} from "../../api/sessions.js";
import { Avatar } from "../avatar.js";
import { StatusGlyph } from "../ui/status-glyph.js";

type WorkingTurnProps = {
  /**
   * assistant_text + tool_call + thinking events for one active turn, in
   * seq-ascending order, all emitted by a single agent (the parent builds one
   * workgroup per agent's current turn). Errors are excluded — they render as
   * their own ErrorRow upstream so failures stay visible regardless of the
   * open/closed state.
   */
  events: SessionEventRow[];
  /** Direct chats pass `true` (expand the process lane); group chats `false`. */
  defaultOpen: boolean;
  agentNameFn: (id: string) => string;
  agentAvatarFn: (id: string) => string | null;
  agentColorTokenFn: (id: string) => string | null;
};

// Tool name → human action verb. Unknown tools fall back to "use <Name>".
const TOOL_VERBS: Record<string, string> = {
  Bash: "run",
  command: "run",
  Read: "read",
  Grep: "search",
  Glob: "find",
  Edit: "edit",
  MultiEdit: "edit",
  Write: "write",
  NotebookEdit: "edit",
  WebFetch: "fetch",
  WebSearch: "search web",
  Task: "delegate",
  TodoWrite: "plan",
  // Cursor handler tool names (lowercase, provider-scoped).
  shell: "run",
  read: "read",
  edit: "edit",
  write: "write",
};

function formatDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

function formatElapsed(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}m${s.toString().padStart(2, "0")}s`;
}

function fullArgs(args: unknown): string | undefined {
  if (args === undefined || args === null) return undefined;
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args);
  } catch {
    return undefined;
  }
}

function readString(args: unknown, key: string): string {
  if (typeof args !== "object" || args === null) return "";
  const v = (args as Record<string, unknown>)[key];
  return typeof v === "string" ? v : "";
}

function displayArgs(p: ToolCallEventPayload): unknown {
  if (p.name !== "command" || typeof p.args !== "object" || p.args === null) return p.args;
  const command = readString(p.args, "command");
  if (!command) return p.args;
  return { ...(p.args as Record<string, unknown>), command: stripShellCommandDisplayWrapper(command) };
}

function basename(path: string): string {
  const tail = path.split("/").pop() ?? path;
  return tail.length > 0 ? tail : path;
}

// Map a tool call to a readable "verb + one key argument" instead of dumping
// the raw JSON payload. The full argument blob stays available on hover via
// the row's `title`.
function describeTool(p: ToolCallEventPayload): { verb: string; target: string } {
  const verb = TOOL_VERBS[p.name];
  if (!verb) return { verb: "use", target: p.name };
  switch (p.name) {
    case "Bash":
      return { verb, target: readString(p.args, "command").split("\n")[0] ?? "" };
    case "command":
    case "shell":
      return { verb, target: stripShellCommandDisplayWrapper(readString(p.args, "command")).split("\n")[0] ?? "" };
    case "Read":
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
    case "read":
    case "edit":
    case "write": {
      const path = readString(p.args, "file_path") || readString(p.args, "path") || readString(p.args, "notebook_path");
      return { verb, target: path ? basename(path) : "" };
    }
    case "Grep":
    case "Glob":
      return { verb, target: readString(p.args, "pattern") };
    case "WebFetch":
      return { verb, target: readString(p.args, "url") };
    case "WebSearch":
      return { verb, target: readString(p.args, "query") };
    case "Task":
      return { verb, target: readString(p.args, "description") || readString(p.args, "subagent_type") };
    default:
      return { verb, target: "" };
  }
}

// Tool results are raw, often multi-line output — surface only the first
// non-empty line as a dimmed peek of what the tool returned.
function resultPreviewLine(preview: string | undefined): string {
  if (!preview) return "";
  return (preview.split("\n").find((l) => l.trim().length > 0) ?? "").trim();
}

function ToolCallLine({ event }: { event: SessionEventRow }) {
  const payload = asToolCallPayload(event.payload);
  if (!payload) return null;
  const isErr = payload.status === "error";
  const isPending = payload.status === "pending";
  const { verb, target } = describeTool(payload);
  const result = isPending ? "" : resultPreviewLine(payload.resultPreview);
  const argsTitle = fullArgs(displayArgs(payload));
  return (
    <div
      className="mono flex items-center text-label"
      style={{ gap: 8, padding: "var(--sp-0_5) 0", color: "var(--fg-3)" }}
    >
      {isPending ? (
        // In-progress: the shared working atom (blue dot + canonical pulse, §9.1).
        <span style={{ display: "inline-flex", flexShrink: 0 }}>
          <StatusGlyph colorVar="var(--state-working)" shape="dot" pulse="working" size={6} />
        </span>
      ) : (
        <span aria-hidden style={{ color: isErr ? "var(--state-error)" : "var(--fg-4)", flexShrink: 0 }}>
          {isErr ? "⚠" : "↳"}
        </span>
      )}
      <span className="flex items-baseline" style={{ minWidth: 0, flex: 1 }} title={argsTitle}>
        <span style={{ flexShrink: 0, color: "var(--fg-3)" }}>{verb}</span>
        {target ? (
          <span className="truncate" style={{ color: "var(--fg-2)", minWidth: 0, flexShrink: 1, marginLeft: 6 }}>
            {target}
          </span>
        ) : null}
        {payload.durationMs !== undefined && !isPending ? (
          <span
            className="text-caption"
            style={{ color: "var(--fg-4)", marginLeft: 6, whiteSpace: "nowrap", flexShrink: 0 }}
          >
            · {formatDuration(payload.durationMs)}
          </span>
        ) : null}
        {result ? (
          <span className="truncate" style={{ color: "var(--fg-4)", minWidth: 0, flex: 1, marginLeft: 6 }}>
            · {result}
          </span>
        ) : null}
      </span>
    </div>
  );
}

function ThinkingLine() {
  return (
    <div
      className="mono flex items-center text-label"
      style={{ gap: 8, padding: "var(--sp-0_5) 0", color: "var(--fg-3)" }}
    >
      {/* In-progress: the shared working atom (blue dot + canonical pulse, §9.1). */}
      <StatusGlyph colorVar="var(--state-working)" shape="dot" pulse="working" size={6} />
      <span style={{ color: "var(--fg-3)" }}>thinking…</span>
    </div>
  );
}

function renderProcessLine(event: SessionEventRow): React.ReactNode {
  if (event.kind === "tool_call") return <ToolCallLine event={event} />;
  if (event.kind === "thinking") return <ThinkingLine />;
  return null;
}

// Live, content-independent "still working" signal: re-render every second so
// the header's elapsed counter keeps ticking even when no new event arrives.
function useElapsedSeconds(startIso: string): number {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return Math.max(0, Math.round((now - new Date(startIso).getTime()) / 1000));
}

export function WorkingTurn({ events, defaultOpen, agentNameFn, agentAvatarFn, agentColorTokenFn }: WorkingTurnProps) {
  // `open` is local state so a manual toggle survives incoming events. It only
  // resets on remount, which the parent triggers when `turn_end` ends the turn.
  const [open, setOpen] = useState<boolean>(defaultOpen);

  const first = events[0];
  const elapsedSec = useElapsedSeconds(first?.createdAt ?? new Date().toISOString());
  if (!first) return null;

  const agentId = first.agentId;
  const name = agentNameFn(agentId);

  // Body = the latest narration segment (A1: always show newest, no stacking).
  let bodyText = "";
  for (const e of events) {
    if (e.kind !== "assistant_text") continue;
    const p = asAssistantTextPayload(e.payload);
    if (p) bodyText = p.text;
  }

  // Process lane = tool_call / thinking only. The latest is the "current step".
  const processEvents = events.filter((e) => e.kind === "tool_call" || e.kind === "thinking");
  const hasProcess = processEvents.length > 0;
  const current = processEvents[processEvents.length - 1];
  const toolCount = processEvents.filter((e) => e.kind === "tool_call").length;
  const thinkingCount = processEvents.length - toolCount;

  const header = (
    <div className="flex items-baseline" style={{ gap: 6, minWidth: 0 }}>
      <span className="mono text-label font-semibold" style={{ color: "var(--primary)", flexShrink: 0 }}>
        {name}
      </span>
      <span style={{ display: "inline-flex", flexShrink: 0 }}>
        <StatusGlyph colorVar="var(--state-working)" shape="dot" pulse="working" size={8} />
      </span>
      <span className="mono text-caption" style={{ color: "var(--state-working)", flexShrink: 0 }}>
        <span className="font-semibold">working</span> · {formatElapsed(elapsedSec)}
      </span>
    </div>
  );

  // Expand/collapse control for the process lane. A legible "▾ N steps" /
  // "▴ N tools · M thinking" line — not a faint chevron — keeps the
  // "see the full process" affordance discoverable in the borderless layout.
  const toggleStyle: React.CSSProperties = {
    background: "transparent",
    border: 0,
    padding: "var(--sp-0_5) 0 0",
    cursor: "pointer",
    color: "var(--fg-3)",
  };

  return (
    // Borderless, plain-text style — no card chrome. Grouping alone (one
    // component per turn) cures the timeline fragmentation; the single
    // avatar/header + whitespace bind the block, like a normal message row.
    // Anchor for the compose rail's jump-to-timeline (working → this agent's
    // in-progress turn). Best-effort: it unmounts when the turn ends.
    <div data-working-agent={agentId} style={{ padding: "var(--sp-1) 0" }}>
      <div className="grid" style={{ gridTemplateColumns: "var(--sp-5) 1fr", columnGap: 8 }}>
        <Avatar
          src={agentAvatarFn(agentId)}
          name={name}
          seed={agentId}
          colorToken={agentColorTokenFn(agentId)}
          size={20}
        />
        <div className="min-w-0">
          {header}

          {bodyText ? (
            <div className="text-body" style={{ color: "var(--fg)", whiteSpace: "pre-wrap", marginTop: 2 }}>
              {bodyText}
            </div>
          ) : null}

          {hasProcess ? (
            <div style={{ marginTop: "var(--sp-1_5)" }}>
              {open ? (
                <>
                  {/* Spine: a thin rail ties the steps into one connected
                      sequence without re-introducing a card border. */}
                  <div style={{ borderLeft: "var(--hairline) solid var(--border)", paddingLeft: "var(--sp-2)" }}>
                    {processEvents.map((e) => (
                      <div key={e.id}>{renderProcessLine(e)}</div>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => setOpen(false)}
                    className="mono text-caption"
                    style={toggleStyle}
                    aria-expanded
                    aria-label="Collapse working details"
                  >
                    ▴ {toolCount} {toolCount === 1 ? "tool" : "tools"} · {thinkingCount} thinking
                  </button>
                </>
              ) : (
                <>
                  {current ? renderProcessLine(current) : null}
                  {processEvents.length > 1 ? (
                    <button
                      type="button"
                      onClick={() => setOpen(true)}
                      className="mono text-caption"
                      style={toggleStyle}
                      aria-expanded={false}
                      aria-label="Expand working details"
                    >
                      ▾ {processEvents.length} steps
                    </button>
                  ) : null}
                </>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
