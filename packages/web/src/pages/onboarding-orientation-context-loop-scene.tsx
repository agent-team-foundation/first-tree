import type { ContextTreeSnapshot } from "@first-tree/shared";
import {
  ArrowRight,
  Bot,
  CheckCircle2,
  CircleDollarSign,
  Code2,
  FileCheck2,
  Network,
  ShieldCheck,
  TestTube2,
  Users,
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { StatusGlyph } from "../components/ui/status-glyph.js";
import { ContextPage } from "./context.js";
import { MOCK_CONTEXT_SNAPSHOT } from "./context-preview-mock.js";

type LoopPhase = "map" | "read" | "work" | "distill" | "review" | "update" | "reuse";

const LOOP_STAGES: readonly { id: LoopPhase; label: string }[] = [
  { id: "read", label: "Read" },
  { id: "work", label: "Work" },
  { id: "distill", label: "Distill" },
  { id: "review", label: "Review" },
  { id: "update", label: "Update" },
  { id: "reuse", label: "Reuse" },
];

const HEADLINES: Record<LoopPhase, { title: string; detail: string }> = {
  map: {
    title: "Shared context is structured—not stuffed into every prompt.",
    detail: "The Tree keeps durable team knowledge organized by domain.",
  },
  read: {
    title: "Read only what this task needs.",
    detail: "Relevant, authorized paths become the Agent's starting context.",
  },
  work: {
    title: "Work from settled constraints.",
    detail: "Design, code, and tests stay aligned without reopening old decisions.",
  },
  distill: {
    title: "Keep the decision. Leave temporary detail with the code.",
    detail: "Only knowledge that should guide future work becomes a Tree candidate.",
  },
  review: {
    title: "Shared context changes only after review.",
    detail: "Evidence, consistency, authorization, and lasting value are checked first.",
  },
  update: {
    title: "Approved knowledge enters the Tree.",
    detail: "The source-backed decision becomes part of the team's shared context.",
  },
  reuse: {
    title: "The approved decision becomes the next Agent's starting point.",
    detail: "Every completed loop makes the following task more informed.",
  },
};

const VIDEO_CONTEXT_SNAPSHOT: ContextTreeSnapshot = {
  ...MOCK_CONTEXT_SNAPSHOT,
  syncedAt: "2026-08-04T12:48:00.000Z",
  nodes: MOCK_CONTEXT_SNAPSHOT.nodes.map((node) => {
    if (node.id === "members") return { ...node, title: "Billing", affectedContextArea: "Billing" };
    if (node.id === "nova") return { ...node, title: "Security", affectedContextArea: "Security" };
    if (node.id === "practices") return { ...node, title: "Architecture", affectedContextArea: "Architecture" };
    return node;
  }),
  io: {
    ...MOCK_CONTEXT_SNAPSHOT.io,
    recentEvents: MOCK_CONTEXT_SNAPSHOT.io.recentEvents.map((event, index) => ({
      ...event,
      agentName: index === 1 ? "context-reviewer" : "nova-lead",
      targetPath:
        index === 0
          ? "system/billing/retry-ownership.md"
          : index === 1
            ? "system/security/auth-boundary.md"
            : "decisions/adr-019.md",
      chatTitle: index === 0 ? "prevent-duplicate-charges" : event.chatTitle,
    })),
    writes: MOCK_CONTEXT_SNAPSHOT.io.writes.map((write, index) => ({
      ...write,
      agentName: index === 0 || index === 2 ? "context-reviewer" : write.agentName,
      nodePath: index === 0 || index === 2 ? "system/billing/retry-ownership" : write.nodePath,
      title: index === 0 || index === 2 ? "Retry Ownership" : write.title,
      summary: index === 0 || index === 2 ? "approve billing retry ownership" : write.summary,
      changeType: index === 0 || index === 2 ? "added" : write.changeType,
    })),
  },
};

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function progress(time: number, start: number, end: number): number {
  return clamp((time - start) / (end - start));
}

function ease(value: number): number {
  return 1 - (1 - value) ** 3;
}

function windowOpacity(time: number, enterStart: number, enterEnd: number, exitStart: number, exitEnd: number): number {
  return ease(progress(time, enterStart, enterEnd)) * (1 - ease(progress(time, exitStart, exitEnd)));
}

function phaseAt(time: number): LoopPhase {
  if (time < 14) return "map";
  if (time < 23) return "read";
  if (time < 30) return "work";
  if (time < 38) return "distill";
  if (time < 46) return "review";
  if (time < 49) return "update";
  return "reuse";
}

export function ContextTreeLoopScene({ time }: { time: number }) {
  const phase = phaseAt(time);
  const conceptOpacity = 1 - ease(progress(time, 51.5, 52.5));
  const completionOpacity = windowOpacity(time, 51.5, 52.5, 55.2, 56);
  const productOpacity = windowOpacity(time, 55.2, 56, 57.2, 57.8);

  return (
    <div
      data-context-concept-phase={phase}
      className="relative h-[calc(100vh-3rem)] min-h-0 overflow-hidden bg-background"
    >
      <ConceptOpening time={time} />
      <section className="absolute inset-0" style={{ opacity: conceptOpacity }} aria-label="Context-based work loop">
        <ConceptHeader time={time} phase={phase} />
        <LoopStageRail time={time} phase={phase} />
        <div className="absolute inset-x-0 top-34 h-105">
          <TreeMap time={time} phase={phase} />
          <ReadPanel time={time} />
          <WorkPanel time={time} />
          <DistillPanel time={time} />
          <ReviewPanel time={time} />
          <UpdatePanel time={time} />
          <SharedSnapshotPanel time={time} />
        </div>
      </section>
      <CompletionLoopScene time={time} opacity={completionOpacity} />
      <RealContextReveal opacity={productOpacity} />
      <ClosingCard time={time} />
    </div>
  );
}

function ConceptOpening({ time }: { time: number }) {
  const opacity = 1 - ease(progress(time, 5, 6.5));
  return (
    <section className="pointer-events-none absolute inset-0 z-20 bg-background" style={{ opacity }}>
      <div
        className="absolute left-1/2 top-1/2 flex w-225 -translate-x-1/2 -translate-y-1/2 flex-col items-center text-center"
        style={{ opacity: 1 }}
      >
        <div className="mb-6 flex size-20 items-center justify-center rounded-full border border-state-working/40 bg-state-working/10 text-state-working">
          <Network size={38} strokeWidth={1.8} />
        </div>
        <p className="mono text-eyebrow font-bold uppercase text-state-working">The context-based work loop</p>
        <h1 className="text-display mt-4 max-w-210">Every task should begin with what the team already knows.</h1>
        <p className="text-headline mt-3 text-fg-3">Context Tree carries reviewed knowledge into the next task.</p>
      </div>
    </section>
  );
}

function ConceptHeader({ time, phase }: { time: number; phase: LoopPhase }) {
  const opacity = ease(progress(time, 5.5, 7));
  const copy = HEADLINES[phase];
  return (
    <header className="absolute inset-x-12 top-5 text-center" style={{ opacity }}>
      <p className="mono text-eyebrow font-bold uppercase text-state-working">Context-based work loop</p>
      <h2 className="text-headline mt-2">{copy.title}</h2>
      <p className="text-body mt-1 text-fg-3">{copy.detail}</p>
    </header>
  );
}

function LoopStageRail({ time, phase }: { time: number; phase: LoopPhase }) {
  const opacity = ease(progress(time, 6.5, 8));
  const phaseIndex = LOOP_STAGES.findIndex((stage) => stage.id === phase);
  return (
    <div className="absolute left-1/2 top-25 flex w-180 -translate-x-1/2" style={{ gap: 4, opacity }}>
      {LOOP_STAGES.map((stage, index) => {
        const active = phase === stage.id;
        const reached = phaseIndex >= index;
        return (
          <div key={`${stage.id}-${stage.label}`} className="min-w-0 flex-1 text-center">
            <div
              className="h-1 rounded-full"
              style={{ background: active || reached ? "var(--state-working)" : "var(--border)" }}
            />
            <span className={`mono text-eyebrow mt-1.5 block uppercase ${active ? "text-foreground" : "text-fg-4"}`}>
              {stage.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function TreeMap({ time, phase }: { time: number; phase: LoopPhase }) {
  const enter = ease(progress(time, 6, 8));
  const shift = ease(progress(time, 12, 14));
  const readActive = phase === "read";
  const updated = time >= 46;
  const candidateOpacity = updated ? ease(progress(time, 46, 47.5)) : 0;
  const mapStyle: CSSProperties = {
    left: "50%",
    marginLeft: -280,
    opacity: enter,
    transform: `translateX(${-250 * shift}px) scale(${0.96 + enter * 0.04})`,
    transformOrigin: "center center",
  };
  return (
    <figure className="absolute top-3 h-92 w-140" style={mapStyle} aria-label="Conceptual Context Tree map">
      <svg className="absolute inset-0 h-full w-full" viewBox="0 0 560 368" aria-hidden>
        <title>Context Tree branch connections</title>
        <path d="M280 184 C210 184 196 76 150 76" fill="none" stroke="var(--border-strong)" />
        <path d="M280 184 C210 184 196 184 150 184" fill="none" stroke="var(--border-strong)" />
        <path d="M280 184 C210 184 196 292 150 292" fill="none" stroke="var(--border-strong)" />
        <path d="M280 184 C350 184 364 76 410 76" fill="none" stroke="var(--border-strong)" />
        <path d="M280 184 C350 184 364 292 410 292" fill="none" stroke="var(--border-strong)" />
        <path
          d="M92 106 C92 112 92 116 92 120"
          fill="none"
          stroke="var(--state-working)"
          strokeDasharray="4 4"
          style={{ opacity: candidateOpacity }}
        />
      </svg>
      <MapNode className="left-52.5 top-32 w-35" title="Context Tree" detail="Shared team context" root active />
      <MapNode className="left-5 top-10 w-37.5" title="Billing" detail="Ownership · retry policy" active={readActive} />
      <MapNode className="left-5 top-47 w-37.5" title="Security" detail="Credential boundaries" active={readActive} />
      <MapNode className="left-5 top-74 w-37.5" title="Architecture" detail="Settled ADRs" active={readActive} />
      <MapNode className="left-102.5 top-10 w-37.5" title="Product" detail="Customer behavior" />
      <MapNode className="left-102.5 top-64 w-37.5" title="Practices" detail="Team conventions" />
      <div
        className="absolute left-5 top-30 w-37.5 border border-state-working bg-state-working/10 px-3 py-2 shadow-[var(--shadow-sm)]"
        style={{
          borderRadius: "var(--radius-panel)",
          opacity: candidateOpacity,
          transform: `translateY(${12 * (1 - candidateOpacity)}px)`,
        }}
      >
        <p className="text-label font-semibold">Retry ownership</p>
        <p className="mono text-eyebrow mt-1 text-fg-3">system/billing</p>
      </div>
      {readActive ? (
        <div className="absolute -right-19 top-20 flex w-24 items-center" aria-hidden>
          <span className="size-2 rounded-full bg-state-working" />
          <span className="h-px flex-1 bg-state-working" />
          <span className="text-eyebrow mono ml-1 text-state-working">READ</span>
        </div>
      ) : null}
    </figure>
  );
}

function MapNode({
  className,
  title,
  detail,
  root = false,
  active = false,
}: {
  className: string;
  title: string;
  detail: string;
  root?: boolean;
  active?: boolean;
}) {
  return (
    <div
      className={`absolute border bg-bg-raised px-3 py-3 text-center shadow-[var(--shadow-sm)] ${className}`}
      style={{
        borderColor: active ? "var(--state-working)" : "var(--border)",
        borderRadius: "var(--radius-panel)",
        background: active ? "color-mix(in srgb, var(--state-working) 8%, var(--bg-raised))" : "var(--bg-raised)",
      }}
    >
      {root ? <Network className="mx-auto mb-1.5 text-state-working" size={20} /> : null}
      <p className={root ? "text-subtitle font-semibold" : "text-label font-semibold"}>{title}</p>
      <p className="text-eyebrow mono mt-1 text-fg-4">{detail}</p>
    </div>
  );
}

function StagePanel({
  opacity,
  children,
  tone = "neutral",
}: {
  opacity: number;
  children: ReactNode;
  tone?: "neutral" | "review";
}) {
  return (
    <section
      className="absolute left-[57%] top-10 w-100 border bg-bg-raised p-5 shadow-[var(--shadow-md)]"
      style={{
        borderColor: tone === "review" ? "var(--warning)" : "var(--border)",
        borderRadius: "var(--radius-dialog)",
        opacity,
        transform: `translateY(${(1 - opacity) * 10}px)`,
      }}
    >
      {children}
    </section>
  );
}

function ReadPanel({ time }: { time: number }) {
  const opacity = windowOpacity(time, 13.2, 14.3, 22, 23.2);
  return (
    <StagePanel opacity={opacity}>
      <PanelKicker icon={<CircleDollarSign size={16} />} label="Incoming task" />
      <p className="text-title mt-3 font-semibold">Prevent duplicate checkout charges</p>
      <div className="mt-5 border-t border-border pt-4">
        <PanelKicker icon={<Bot size={16} />} label="Agent reads relevant paths" working />
        <div className="mt-3 flex flex-col" style={{ gap: "var(--sp-2)" }}>
          <ContextChip>Billing owns retry execution</ContextChip>
          <ContextChip>Credentials remain server-side</ContextChip>
          <ContextChip>ADR-019 defines idempotency</ContextChip>
        </div>
      </div>
    </StagePanel>
  );
}

function WorkPanel({ time }: { time: number }) {
  const opacity = windowOpacity(time, 22.2, 23.3, 29, 30.2);
  const steps = [
    { label: "Design", icon: <FileCheck2 size={15} />, at: 23.5 },
    { label: "Code", icon: <Code2 size={15} />, at: 25 },
    { label: "Test", icon: <TestTube2 size={15} />, at: 26.8 },
  ];
  return (
    <StagePanel opacity={opacity}>
      <PanelKicker icon={<Bot size={16} />} label="Agent work" working />
      <p className="text-title mt-3 font-semibold">Implement the smallest safe change</p>
      <div className="mt-5 grid grid-cols-3" style={{ gap: "var(--sp-2)" }}>
        {steps.map((step) => {
          const complete = time >= step.at;
          return (
            <div
              key={step.label}
              className="border border-border bg-background px-3 py-4 text-center"
              style={{ borderRadius: "var(--radius-panel)" }}
            >
              <span className="mx-auto flex size-8 items-center justify-center rounded-full bg-muted text-fg-2">
                {step.icon}
              </span>
              <p className="text-label mt-2 font-semibold">{step.label}</p>
              <p className={`text-eyebrow mono mt-1 ${complete ? "text-state-working" : "text-fg-4"}`}>
                {complete ? "ALIGNED ✓" : "IN PROGRESS"}
              </p>
            </div>
          );
        })}
      </div>
      <p className="text-caption mt-4 text-fg-3">
        Existing context constrains the work; it does not replace verification.
      </p>
    </StagePanel>
  );
}

function DistillPanel({ time }: { time: number }) {
  const opacity = windowOpacity(time, 29.2, 30.3, 37, 38.2);
  const discard = 1 - ease(progress(time, 32.5, 36));
  const keep = ease(progress(time, 30.3, 31.5));
  return (
    <StagePanel opacity={opacity}>
      <PanelKicker icon={<FileCheck2 size={16} />} label="Distill the outcome" />
      <div
        className="mt-4 border border-state-working bg-state-working/10 px-4 py-4"
        style={{ borderRadius: "var(--radius-panel)", opacity: keep }}
      >
        <p className="mono text-eyebrow font-bold uppercase text-state-working">Keep for future work</p>
        <p className="text-subtitle mt-2 font-semibold">Billing Service owns retry policy and idempotency.</p>
      </div>
      <div className="mt-4" style={{ opacity: discard, transform: `translateY(${(1 - discard) * 12}px)` }}>
        <p className="mono text-eyebrow font-bold uppercase text-fg-4">Leave with the code</p>
        <div className="mt-2 flex flex-wrap" style={{ gap: "var(--sp-2)" }}>
          <span className="text-caption border border-border bg-muted px-2 py-1 text-fg-3">retry loop counter</span>
          <span className="text-caption border border-border bg-muted px-2 py-1 text-fg-3">fixture names</span>
          <span className="text-caption border border-border bg-muted px-2 py-1 text-fg-3">temporary logs</span>
        </div>
      </div>
    </StagePanel>
  );
}

function ReviewPanel({ time }: { time: number }) {
  const opacity = windowOpacity(time, 37.2, 38.3, 45, 46.2);
  const checks = ["Source evidence", "Existing context", "Authorization boundary", "Durable value"];
  const candidate = ease(progress(time, 38, 39));
  const approved = ease(progress(time, 44, 45));
  return (
    <StagePanel opacity={opacity} tone="review">
      <PanelKicker icon={<ShieldCheck size={16} />} label="Dedicated Context Reviewer" working tone="review" />
      <div
        className="mt-3 flex items-center border border-warning bg-warning/10 px-3 py-2.5"
        style={{ borderRadius: "var(--radius-input)", opacity: candidate }}
      >
        <span className="mono text-eyebrow font-bold uppercase text-warning">Tree candidate</span>
        <ArrowRight className="mx-2 text-warning" size={14} />
        <span className="text-label font-semibold">Billing owns retry policy</span>
      </div>
      <div className="mt-4 flex flex-col" style={{ gap: "var(--sp-2)" }}>
        {checks.map((check, index) => {
          const checked = ease(progress(time, 39 + index * 1.25, 40 + index * 1.25));
          return (
            <div
              key={check}
              className="flex items-center border border-border bg-background px-3 py-2.5"
              style={{ borderRadius: "var(--radius-input)" }}
            >
              <CheckCircle2 size={15} style={{ color: checked > 0.5 ? "var(--state-working)" : "var(--fg-4)" }} />
              <span className="text-label ml-2 font-medium">{check}</span>
              <span className={`mono text-eyebrow ml-auto ${checked > 0.5 ? "text-state-working" : "text-fg-4"}`}>
                {checked > 0.5 ? "PASS" : "CHECKING"}
              </span>
            </div>
          );
        })}
      </div>
      <div
        className="mt-3 flex items-center border border-state-working bg-state-working/10 px-3 py-2.5"
        style={{ borderRadius: "var(--radius-input)", opacity: approved }}
      >
        <CheckCircle2 className="text-state-working" size={15} />
        <span className="mono text-eyebrow ml-2 font-bold uppercase text-state-working">Approved for update</span>
      </div>
    </StagePanel>
  );
}

function UpdatePanel({ time }: { time: number }) {
  const opacity = windowOpacity(time, 45.2, 46.3, 48.2, 49.2);
  return (
    <StagePanel opacity={opacity}>
      <PanelKicker icon={<CheckCircle2 size={16} />} label="Approved Tree update" working />
      <div
        className="mt-4 border border-state-working bg-state-working/10 px-4 py-4"
        style={{ borderRadius: "var(--radius-panel)" }}
      >
        <p className="text-subtitle font-semibold">system/billing/retry-ownership</p>
        <p className="text-caption mt-1 text-fg-3">Source-backed · reviewed · available to future tasks</p>
      </div>
      <div className="mt-5 flex items-center border-t border-border pt-4 text-state-working">
        <ArrowRight size={16} />
        <p className="text-label ml-2 font-semibold">Published into the team's shared snapshot</p>
      </div>
    </StagePanel>
  );
}

function SharedSnapshotPanel({ time }: { time: number }) {
  const opacity = windowOpacity(time, 48.4, 49.4, 51.5, 52.5);
  const consumers = [
    { agent: "nova-lead", task: "Plan mobile checkout retries" },
    { agent: "forge-dev", task: "Change the payment worker" },
    { agent: "QA Agent", task: "Test duplicate-charge recovery" },
  ];
  return (
    <StagePanel opacity={opacity}>
      <PanelKicker icon={<Users size={16} />} label="New team snapshot" working />
      <div
        className="mt-4 border border-state-working bg-state-working/10 px-4 py-3"
        style={{ borderRadius: "var(--radius-panel)" }}
      >
        <p className="text-subtitle font-semibold">Billing retry ownership</p>
        <p className="text-caption mt-1 text-fg-3">One reviewed decision · many future tasks</p>
      </div>
      <div className="mt-3 flex flex-col" style={{ gap: "var(--sp-2)" }}>
        {consumers.map((consumer, index) => {
          const visible = ease(progress(time, 49.1 + index * 0.5, 49.8 + index * 0.5));
          return (
            <div
              key={consumer.agent}
              className="flex items-center border border-border bg-background px-3 py-2.5"
              style={{ borderRadius: "var(--radius-input)", opacity: visible }}
            >
              <Bot className="text-fg-3" size={15} />
              <span className="text-label ml-2 font-semibold">{consumer.agent}</span>
              <ArrowRight className="mx-2 text-state-working" size={13} />
              <span className="text-caption text-fg-3">{consumer.task}</span>
            </div>
          );
        })}
      </div>
    </StagePanel>
  );
}

function CompletionLoopScene({ time, opacity }: { time: number; opacity: number }) {
  const draw = ease(progress(time, 52, 55));
  const stages = [
    { label: "Read", detail: "Relevant paths", className: "left-1/2 top-25 -translate-x-1/2" },
    { label: "Work", detail: "Design · code · test", className: "right-38 top-46" },
    { label: "Distill", detail: "Durable outcome", className: "right-42 top-99" },
    { label: "Review", detail: "Evidence · boundaries", className: "left-1/2 top-119 -translate-x-1/2" },
    { label: "Update", detail: "Shared snapshot", className: "left-42 top-99" },
    { label: "Reuse", detail: "Next task starts here", className: "left-38 top-46" },
  ];
  return (
    <section
      className="pointer-events-none absolute inset-0 z-[25] overflow-hidden bg-background"
      style={{ opacity }}
      aria-label="Completed Context-based work loop"
    >
      <header className="absolute inset-x-12 top-5 text-center">
        <p className="mono text-eyebrow font-bold uppercase text-state-working">The context-based work loop</p>
        <h2 className="text-headline mt-2">One reviewed outcome improves every task that follows.</h2>
      </header>
      <svg className="absolute inset-0 h-full w-full" viewBox="0 0 1280 672" aria-hidden>
        <title>Context-based work loop completion</title>
        <defs>
          <marker
            id="context-loop-arrow"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--state-working)" />
          </marker>
        </defs>
        <circle cx="640" cy="330" r="202" fill="none" stroke="var(--border)" strokeWidth="2" />
        <circle
          cx="640"
          cy="330"
          r="202"
          fill="none"
          stroke="var(--state-working)"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray="1269"
          strokeDashoffset={1269 * (1 - draw)}
          transform="rotate(-90 640 330)"
        />
        <path
          d="M 798 204 A 202 202 0 0 1 842 330"
          fill="none"
          stroke="var(--state-working)"
          strokeWidth="3"
          markerEnd="url(#context-loop-arrow)"
          style={{ opacity: draw }}
        />
      </svg>
      <div
        className="absolute top-64 flex size-52 items-center justify-center rounded-full border border-state-working bg-state-working/10 text-center shadow-[var(--shadow-md)]"
        style={{ left: "50%", marginLeft: -104, transform: `scale(${0.94 + draw * 0.06})` }}
      >
        <div>
          <Network className="mx-auto text-state-working" size={30} />
          <p className="text-title mt-3 font-semibold">Context Tree</p>
          <p className="text-caption mt-1 text-fg-3">Shared, reviewed context</p>
        </div>
      </div>
      {stages.map((stage, index) => {
        const visible = ease(progress(time, 52 + index * 0.15, 52.45 + index * 0.15));
        return (
          <div
            key={stage.label}
            className={`absolute w-45 border border-border bg-bg-raised px-3 py-2.5 text-center shadow-[var(--shadow-sm)] ${stage.className}`}
            style={{ borderRadius: "var(--radius-panel)", opacity: visible }}
          >
            <p className="text-label font-semibold">{stage.label}</p>
            <p className="mono text-eyebrow mt-1 text-fg-4">{stage.detail}</p>
          </div>
        );
      })}
    </section>
  );
}

function PanelKicker({
  icon,
  label,
  working = false,
  tone = "normal",
}: {
  icon: ReactNode;
  label: string;
  working?: boolean;
  tone?: "normal" | "review";
}) {
  return (
    <div className="flex items-center">
      <span
        className="flex size-8 items-center justify-center rounded-full"
        style={{
          background: tone === "review" ? "color-mix(in srgb, var(--warning) 12%, var(--bg))" : "var(--bg-hover)",
          color: tone === "review" ? "var(--warning)" : "var(--fg-2)",
        }}
      >
        {icon}
      </span>
      <span className="mono text-eyebrow ml-2 font-bold uppercase text-fg-3">{label}</span>
      {working ? (
        <span className="ml-auto flex items-center text-caption text-state-working">
          <StatusGlyph
            colorVar={tone === "review" ? "var(--warning)" : "var(--state-working)"}
            shape="dot"
            pulse="working"
            size={8}
          />
          <span className="ml-1.5">Working</span>
        </span>
      ) : null}
    </div>
  );
}

function ContextChip({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex items-center border border-border bg-background px-3 py-2.5"
      style={{ borderRadius: "var(--radius-input)" }}
    >
      <StatusGlyph colorVar="var(--state-working)" shape="dot" pulse={null} size={7} />
      <span className="text-label ml-2">{children}</span>
    </div>
  );
}

function RealContextReveal({ opacity }: { opacity: number }) {
  return (
    <section
      className="absolute inset-0 z-30 overflow-hidden bg-background"
      style={{ opacity, transform: `scale(${0.985 + opacity * 0.015})`, transformOrigin: "center top" }}
      aria-label="First Tree Context product page"
    >
      <div className="mx-auto p-6" style={{ maxWidth: 960 }}>
        <ContextPage previewSnapshot={VIDEO_CONTEXT_SNAPSHOT} />
      </div>
    </section>
  );
}

function ClosingCard({ time }: { time: number }) {
  const opacity = ease(progress(time, 57.3, 58));
  return (
    <section
      className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-background text-center"
      style={{ opacity }}
      aria-label="Every task starts smarter"
    >
      <div style={{ transform: `translateY(${(1 - opacity) * 12}px)` }}>
        <div className="mx-auto flex size-18 items-center justify-center rounded-full border border-state-working bg-state-working/10 text-state-working">
          <Network size={32} strokeWidth={1.8} />
        </div>
        <p className="mono text-eyebrow mt-5 font-bold uppercase text-state-working">Context that compounds</p>
        <h2 className="text-display mt-3">Every task starts smarter.</h2>
        <p className="text-headline mt-3 text-fg-3">Every reviewed outcome improves the next task.</p>
      </div>
    </section>
  );
}
