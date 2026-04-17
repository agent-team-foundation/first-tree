import type { Agent, AgentRuntimeConfig } from "@agent-team-foundation/first-tree-hub-shared";
import { cn, formatDate } from "../../lib/utils.js";

/**
 * Redesign §5.2 Status Bar — a single tri-line banner that answers
 * "can this agent work right now?" in one glance. Colour shifts with state
 * instead of scattering pills across the page.
 */

export type ClientStatusInfo = {
  online: boolean;
  clientId: string | null;
  offlineSince: string | null;
};

export type StatusBarInputs = {
  agent: Agent;
  cfg?: AgentRuntimeConfig;
  clientStatus?: ClientStatusInfo;
  runtimeState?: string | null;
  runtimeType?: string | null;
  activeSessions?: number | null;
  isHuman: boolean;
};

type Tone = "neutral" | "danger" | "warning" | "muted";

function toneClasses(tone: Tone): string {
  switch (tone) {
    case "danger":
      return "border-red-300 bg-red-50 text-red-900";
    case "warning":
      return "border-amber-300 bg-amber-50 text-amber-900";
    case "muted":
      return "border-gray-300 bg-gray-50 text-gray-700";
    default:
      return "border-gray-200 bg-white text-gray-800";
  }
}

function dotClasses(tone: Tone): string {
  switch (tone) {
    case "danger":
      return "bg-red-500";
    case "warning":
      return "bg-amber-500";
    case "muted":
      return "bg-gray-400";
    default:
      return "bg-green-500";
  }
}

function derivePrimary(inputs: StatusBarInputs): { tone: Tone; symbol: string; label: string } {
  const { agent, clientStatus, runtimeState, isHuman } = inputs;
  if (agent.status === "suspended") {
    return { tone: "muted", symbol: "◌", label: "Suspended" };
  }
  if (isHuman) {
    return { tone: "neutral", symbol: "●", label: "Active" };
  }
  if (clientStatus?.offlineSince && !clientStatus.clientId) {
    return { tone: "muted", symbol: "○", label: "Unclaimed" };
  }
  if (clientStatus && !clientStatus.online) {
    return { tone: "warning", symbol: "⚠", label: "Client offline" };
  }
  if (runtimeState === "error") return { tone: "danger", symbol: "●", label: "Error" };
  if (runtimeState === "working") return { tone: "neutral", symbol: "●", label: "Working" };
  if (runtimeState === "idle") return { tone: "neutral", symbol: "●", label: "Idle" };
  return { tone: "neutral", symbol: "●", label: "Online" };
}

function relative(date?: string | null): string {
  if (!date) return "—";
  const then = new Date(date).getTime();
  const diffMs = Date.now() - then;
  if (!Number.isFinite(diffMs) || diffMs < 0) return formatDate(date);
  const m = Math.floor(diffMs / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function StatusBar(inputs: StatusBarInputs) {
  const { agent, cfg, clientStatus, runtimeType, activeSessions, isHuman } = inputs;
  const primary = derivePrimary(inputs);

  const line1Tail: string[] = [];
  if (!isHuman && runtimeType) line1Tail.push(runtimeType);
  if (!isHuman && typeof activeSessions === "number") {
    line1Tail.push(`${activeSessions} session${activeSessions === 1 ? "" : "s"}`);
  }
  if (cfg) line1Tail.push(`config v${cfg.version}`);

  const offlineSince = clientStatus?.offlineSince;
  const showOfflineHint = !isHuman && clientStatus && !clientStatus.online;

  return (
    <div className={cn("rounded-md border px-4 py-3 text-sm space-y-1", toneClasses(primary.tone))}>
      <div className="flex items-center gap-2 font-medium">
        <span className={cn("inline-block h-2 w-2 rounded-full", dotClasses(primary.tone))} aria-hidden />
        <span>{primary.symbol === "⚠" ? primary.symbol : null}</span>
        <span>{primary.label}</span>
        {line1Tail.length > 0 && <span className="text-muted-foreground font-normal">· {line1Tail.join(" · ")}</span>}
      </div>

      {!isHuman && (
        <div className="text-xs text-muted-foreground">
          {clientStatus?.clientId ? (
            <>
              Client <span className="font-mono">{clientStatus.clientId}</span>
              {clientStatus.online ? null : (
                <>
                  {" · offline since "}
                  <span>{formatDate(offlineSince)}</span>
                </>
              )}
            </>
          ) : (
            <span>No client bound yet</span>
          )}
        </div>
      )}

      {cfg && (
        <div className="text-xs text-muted-foreground">
          Config updated by <span className="font-medium">{cfg.updatedBy || "—"}</span> · {relative(cfg.updatedAt)}
        </div>
      )}

      {showOfflineHint && (
        <p className="mt-1 text-xs text-amber-900">Changes saved here won't take effect until the client reconnects.</p>
      )}
      {!isHuman && !clientStatus?.clientId && agent.status === "active" && (
        <p className="mt-1 text-xs text-muted-foreground">
          Configure now; it will apply when a client claims this agent.
        </p>
      )}
    </div>
  );
}

export function deriveSaveHint(opts: { activeSessions: number; isUnclaimed: boolean; isOffline: boolean }): string {
  if (opts.isUnclaimed) {
    return "Saving: configuration stored; will apply when a client claims this agent.";
  }
  if (opts.isOffline) {
    return "Saving: configuration stored; will apply when the client reconnects.";
  }
  if (opts.activeSessions > 0) {
    return `Saving: new chats use this immediately; ${opts.activeSessions} active chat${
      opts.activeSessions === 1 ? "" : "s"
    } switch on their next message.`;
  }
  return "Saving: new chats use this immediately.";
}
