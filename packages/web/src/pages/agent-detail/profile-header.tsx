import type { Agent } from "@agent-team-foundation/first-tree-hub-shared";
import { Bot, Cog, MessageCircle, MessageSquare, Play, Sparkles, Terminal, User, Users, Zap } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../../components/ui/button.js";
import { DenseBadge } from "../../components/ui/dense-badge.js";
import { StateChip } from "../../components/ui/state-chip.js";
import { formatDate } from "../../lib/utils.js";

/**
 * X-style ProfileHeader for the agent detail page. All data is pulled from
 * fields the agent schema already exposes — no user customization, no extra
 * backend work. Designed to gracefully degrade for Human agents (no runtime,
 * no tool count) and to fall back to neutral styling when optional fields
 * (description, owner, org, model, runtime) are missing.
 *
 * Runtime differentiation:
 *  - Each runtime picks a single primary colour token. The banner blends that
 *    token into a gradient and overlays a low-opacity diagonal-stripe pattern
 *    for texture. The avatar disc uses the same token at a higher mix so the
 *    avatar visually echoes the banner instead of clashing with it.
 *  - The avatar icon itself differs per runtime (Sparkles / Terminal /
 *    MessageCircle / Zap) so Claude and Codex — both green-leaning palettes —
 *    still read as distinct at a glance.
 */

export type ProfileHeaderProps = {
  agent: Agent;
  runtimeState: string | null;
  runtimeType: string | null;
  ownerName: string | null;
  orgLabel: string | null;
  activeSessions: number;
  /** Either a number (from the runtime) or string like "—" when unavailable. */
  totalSessions: number | string;
  /** Count of MCP servers configured (tools). Null when cfg hasn't loaded / human agent. */
  toolsCount: number | null;
  /** First line of the agent's description / bio. Null if absent. */
  tagline: string | null;
  isHuman: boolean;
  onOpenChat: () => void;
  onTest?: () => void;
  testPending?: boolean;
};

export function ProfileHeader(props: ProfileHeaderProps) {
  const { agent, isHuman } = props;
  const runtimeKind = normalizeRuntime(props.runtimeType, isHuman);
  const palette = RUNTIME_PALETTE[runtimeKind];
  const handle = agent.name ?? agent.uuid.slice(0, 8);
  // If displayName is empty OR equals the @handle, we skip the subtitle entirely
  // to avoid "coder-agent / @coder-agent" double-print. The handle then becomes
  // the primary heading.
  const rawDisplay = (agent.displayName ?? "").trim();
  const hasDistinctDisplayName = rawDisplay.length > 0 && rawDisplay !== handle;
  const primaryTitle = hasDistinctDisplayName ? rawDisplay : `@${handle}`;
  const initials = initialsFromName(hasDistinctDisplayName ? rawDisplay : handle);

  return (
    <section
      style={{
        background: "var(--bg-raised)",
        border: "var(--hairline) solid var(--border)",
        borderRadius: "var(--radius-panel)",
        overflow: "hidden",
      }}
    >
      <div
        aria-hidden
        style={{
          height: 112,
          background: `
            repeating-linear-gradient(135deg,
              color-mix(in oklab, ${palette.primary} 6%, transparent) 0 var(--sp-3),
              transparent var(--sp-3) var(--sp-6)),
            linear-gradient(135deg,
              color-mix(in oklab, ${palette.primary} 55%, transparent),
              color-mix(in oklab, ${palette.secondary} 32%, transparent))
          `.replace(/\s+/g, " "),
          borderBottom: "var(--hairline) solid var(--border-faint)",
        }}
      />
      <div style={{ position: "relative", padding: "var(--sp-5) var(--sp-5) var(--sp-4)" }}>
        <div
          className="inline-flex items-center justify-center"
          style={{
            position: "absolute",
            top: -40,
            left: "var(--sp-5)",
            width: 80,
            height: 80,
            borderRadius: "50%",
            background: "var(--bg-raised)",
            border: "var(--hairline-bold) solid var(--bg-raised)",
            boxShadow: "0 0 0 var(--hairline) var(--border)",
            overflow: "hidden",
          }}
        >
          <Avatar runtimeKind={runtimeKind} isHuman={isHuman} initials={initials} />
        </div>

        <div className="flex items-start justify-between gap-3" style={{ marginLeft: 96, minHeight: 48 }}>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className={hasDistinctDisplayName ? "text-title" : "mono text-title"} style={{ color: "var(--fg)" }}>
                {primaryTitle}
              </h1>
              <BadgeCluster agent={agent} runtimeState={props.runtimeState} isHuman={isHuman} />
            </div>
            {hasDistinctDisplayName && (
              <div className="mono text-label" style={{ color: "var(--fg-4)" }}>
                @{handle}
              </div>
            )}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <StateChip state={props.runtimeState} />
            <Button variant="ghost" size="xs" onClick={props.onOpenChat}>
              <MessageSquare className="h-3 w-3" /> Open chat
            </Button>
            {!isHuman && agent.status === "active" && props.onTest && (
              <Button variant="outline" size="xs" onClick={props.onTest} disabled={props.testPending}>
                <Play className="h-3 w-3" />
                {props.testPending ? "Testing…" : "Test"}
              </Button>
            )}
          </div>
        </div>

        {props.tagline && (
          <p className="text-body" style={{ marginTop: "var(--sp-2_5)", color: "var(--fg-2)", maxWidth: 720 }}>
            {props.tagline}
          </p>
        )}

        <MetaRow agent={props.agent} ownerName={props.ownerName} orgLabel={props.orgLabel} />

        <StatsRow
          activeSessions={props.activeSessions}
          totalSessions={props.totalSessions}
          toolsCount={props.toolsCount}
          isHuman={isHuman}
        />
      </div>
    </section>
  );
}

/* ---------- sub-components ---------- */

function BadgeCluster({
  agent,
  runtimeState,
  isHuman,
}: {
  agent: Agent;
  runtimeState: string | null;
  isHuman: boolean;
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <DenseBadge tone={agent.type === "autonomous_agent" ? "accent" : "neutral"}>{agent.type}</DenseBadge>
      {isHuman ? (
        <DenseBadge tone="outline">
          <span className="inline-flex items-center gap-1">
            <User className="h-3 w-3" aria-hidden />
            human
          </span>
        </DenseBadge>
      ) : (
        <DenseBadge tone="outline">
          <span className="inline-flex items-center gap-1">
            <Bot className="h-3 w-3" aria-hidden />
            automated
          </span>
        </DenseBadge>
      )}
      {agent.status !== "active" && (
        <DenseBadge tone={agent.status === "suspended" ? "warn" : "outline"}>{agent.status}</DenseBadge>
      )}
      {runtimeState === "error" && <DenseBadge tone="error">runtime error</DenseBadge>}
      {agent.visibility && (
        <DenseBadge tone={agent.visibility === "organization" ? "accent" : "outline"}>{agent.visibility}</DenseBadge>
      )}
    </span>
  );
}

type MetaItemDef = { key: string; icon: ReactNode; body: ReactNode };

function MetaRow(props: { agent: Agent; ownerName: string | null; orgLabel: string | null }) {
  // After the ContextBar takeover, ProfileHeader's Meta only carries identity
  // facts (joined / owner / org) — Runs on + Model live in the sticky bar.
  const items: MetaItemDef[] = [];
  items.push({
    key: "created",
    icon: <Cog className="h-3 w-3" aria-hidden />,
    body: (
      <>
        Joined <span style={{ color: "var(--fg-2)" }}>{formatDate(props.agent.createdAt)}</span>
      </>
    ),
  });
  if (props.ownerName) {
    items.push({
      key: "owner",
      icon: <User className="h-3 w-3" aria-hidden />,
      body: (
        <>
          Owner <span style={{ color: "var(--fg-2)" }}>{props.ownerName}</span>
        </>
      ),
    });
  }
  if (props.orgLabel) {
    items.push({
      key: "org",
      icon: <Users className="h-3 w-3" aria-hidden />,
      body: <span style={{ color: "var(--fg-2)" }}>{props.orgLabel}</span>,
    });
  }
  return (
    <div
      className="flex flex-wrap items-center text-label"
      style={{ marginTop: "var(--sp-2_5)", color: "var(--fg-3)", rowGap: "var(--sp-1)" }}
    >
      {items.map((it, idx) => (
        <span key={it.key} className="inline-flex items-center">
          {idx > 0 && (
            <span style={{ color: "var(--fg-4)", margin: "0 var(--sp-2)" }} aria-hidden>
              ·
            </span>
          )}
          <MetaItem icon={it.icon}>{it.body}</MetaItem>
        </span>
      ))}
    </div>
  );
}

function MetaItem({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1">
      {icon}
      {children}
    </span>
  );
}

function StatsRow(props: {
  activeSessions: number;
  totalSessions: number | string;
  toolsCount: number | null;
  isHuman: boolean;
}) {
  const tiles: Array<{ key: string; label: string; value: ReactNode }> = [];
  // Sessions: when total isn't a real number we collapse to a single value
  // ("0 Sessions") rather than render "0 / —", which read as "an error".
  const totalIsNumber = typeof props.totalSessions === "number";
  tiles.push({
    key: "sessions",
    label: "Sessions",
    value: totalIsNumber ? (
      <span className="mono tnum">
        <span style={{ color: "var(--fg)" }}>{props.activeSessions}</span>
        <span style={{ color: "var(--fg-4)" }}> / {props.totalSessions}</span>
      </span>
    ) : (
      <span className="mono tnum" style={{ color: "var(--fg)" }}>
        {props.activeSessions}
      </span>
    ),
  });
  if (!props.isHuman && props.toolsCount != null && props.toolsCount > 0) {
    tiles.push({
      key: "tools",
      label: "Tools",
      value: <span className="mono tnum">{props.toolsCount}</span>,
    });
  }
  return (
    <div
      className="flex flex-wrap items-baseline text-label"
      style={{ marginTop: "var(--sp-3)", gap: "var(--sp-5)", color: "var(--fg-3)" }}
    >
      {tiles.map((t) => (
        <span key={t.key} className="inline-flex items-baseline gap-1.5">
          <span>{t.value}</span>
          <span style={{ color: "var(--fg-4)" }}>{t.label}</span>
        </span>
      ))}
    </div>
  );
}

/* ---------- avatar ---------- */

function Avatar({ runtimeKind, isHuman, initials }: { runtimeKind: RuntimeKind; isHuman: boolean; initials: string }) {
  const palette = RUNTIME_PALETTE[runtimeKind];
  if (isHuman) {
    return (
      <span
        role="img"
        aria-label="Human agent avatar"
        className="inline-flex items-center justify-center mono font-semibold text-subtitle"
        style={{
          width: "100%",
          height: "100%",
          background: `color-mix(in oklab, ${palette.primary} 18%, var(--bg-active))`,
          color: `color-mix(in oklab, ${palette.primary} 70%, var(--fg-2))`,
          letterSpacing: "var(--sp-0_25)",
        }}
      >
        {initials}
      </span>
    );
  }
  const RuntimeIcon = RUNTIME_ICONS[runtimeKind];
  return (
    <span
      role="img"
      aria-label={`${RUNTIME_LABELS[runtimeKind]} agent avatar`}
      className="inline-flex items-center justify-center"
      style={{
        width: "100%",
        height: "100%",
        background: `color-mix(in oklab, ${palette.primary} 32%, var(--bg-raised))`,
        color: `color-mix(in oklab, ${palette.primary} 70%, var(--fg))`,
      }}
    >
      <RuntimeIcon style={{ width: 34, height: 34 }} aria-hidden />
    </span>
  );
}

/* ---------- runtime mapping ---------- */

type RuntimeKind = "claude-code" | "kael" | "codex" | "gpt" | "unknown";

const RUNTIME_LABELS: Record<RuntimeKind, string> = {
  "claude-code": "Claude Code",
  kael: "Kael",
  codex: "Codex",
  gpt: "GPT",
  unknown: "—",
};

/**
 * Single primary / secondary color per runtime. Both the banner gradient and
 * the avatar disc derive from the primary so they always echo each other; the
 * secondary just adds direction to the banner gradient.
 */
type RuntimePalette = { primary: string; secondary: string };

const RUNTIME_PALETTE: Record<RuntimeKind, RuntimePalette> = {
  "claude-code": { primary: "var(--accent)", secondary: "var(--state-working)" },
  kael: { primary: "var(--state-blocked)", secondary: "var(--accent)" },
  codex: { primary: "var(--state-working)", secondary: "var(--state-idle)" },
  gpt: { primary: "var(--state-idle)", secondary: "var(--accent)" },
  unknown: { primary: "var(--border-strong)", secondary: "var(--fg-3)" },
};

/** Lucide icon per runtime. Keeps Claude vs Codex visually distinct even
 * though both palettes lean green. */
const RUNTIME_ICONS: Record<RuntimeKind, typeof Bot> = {
  "claude-code": Sparkles,
  kael: Zap,
  codex: Terminal,
  gpt: MessageCircle,
  unknown: Bot,
};

function normalizeRuntime(raw: string | null, isHuman: boolean): RuntimeKind {
  if (isHuman) return "unknown";
  if (!raw) return "claude-code"; // Hub's only shipping runtime today; "no runtime known" still implies Claude Code.
  const v = raw.toLowerCase();
  if (v.includes("claude")) return "claude-code";
  if (v.includes("kael")) return "kael";
  if (v.includes("codex")) return "codex";
  if (v.includes("gpt")) return "gpt";
  return "unknown";
}

function initialsFromName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return trimmed.slice(0, 2).toUpperCase();
  const first = parts[0] ?? "";
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  const last = parts[parts.length - 1] ?? "";
  const a = first.charAt(0);
  const b = last.charAt(0);
  return `${a}${b}`.toUpperCase() || "?";
}
