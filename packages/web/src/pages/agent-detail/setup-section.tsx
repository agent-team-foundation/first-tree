import { Link2, Lock, Play } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../../components/ui/button.js";

/**
 * Setup section — immutable "where it runs" pick, bind-computer banner, and a
 * slot for the Model editor. Two of the three settings (runtime kind, bound
 * computer) are fixed after creation; this section surfaces those facts in a
 * single place before the operator reaches the editable Model control below.
 */

export type SetupRuntimeKind = "claude-code" | "kael";

export type SetupSectionProps = {
  runtimeKind: SetupRuntimeKind;
  /** Display label of the bound computer; null when no computer is bound yet. */
  computerLabel: string | null;
  /** Whether the "Bind computer" CTA should be shown (only when no client is bound and agent is active). */
  canBindComputer: boolean;
  bindComputerPending?: boolean;
  onBindComputer?: () => void;
  /** Slot for the Model dropdown — we reuse the existing ModelSection via composition. */
  modelSlot: ReactNode;
};

const RUNTIME_COPY: Record<SetupRuntimeKind, { name: string; caption: string }> = {
  "claude-code": {
    name: "Claude Code",
    caption: "Anthropic's Claude Code runtime. Fixed after creation — create a new agent to switch.",
  },
  kael: {
    name: "Kael",
    caption: "Kael runtime (coming soon). Fixed after creation — create a new agent to switch.",
  },
};

export function SetupSection(props: SetupSectionProps) {
  const copy = RUNTIME_COPY[props.runtimeKind];
  return (
    <div className="space-y-3">
      <RuntimeCard name={copy.name} caption={copy.caption} locked />

      <ComputerCard
        computerLabel={props.computerLabel}
        canBindComputer={props.canBindComputer}
        bindPending={props.bindComputerPending ?? false}
        onBindComputer={props.onBindComputer}
      />

      {props.modelSlot}
    </div>
  );
}

function RuntimeCard({ name, caption, locked }: { name: string; caption: string; locked: boolean }) {
  return (
    <section
      style={{
        background: "var(--bg-raised)",
        border: "var(--hairline) solid var(--border)",
        borderRadius: 6,
      }}
    >
      <header
        className="flex items-center justify-between"
        style={{ padding: "var(--sp-2_5) var(--sp-3_5)", borderBottom: "var(--hairline) solid var(--border-faint)" }}
      >
        <h3 className="inline-flex items-center gap-2 text-body font-semibold" style={{ color: "var(--fg)" }}>
          Where it runs
          {locked && (
            <span
              className="mono uppercase text-caption inline-flex items-center gap-1"
              style={{ color: "var(--fg-4)" }}
            >
              <Lock className="h-3 w-3" aria-hidden /> locked
            </span>
          )}
        </h3>
      </header>
      <div className="px-4 py-3 text-body space-y-1">
        <div className="inline-flex items-center gap-2">
          <Play className="h-3.5 w-3.5" aria-hidden style={{ color: "var(--accent)" }} />
          <span className="font-medium">{name}</span>
        </div>
        <p className="text-caption" style={{ color: "var(--fg-3)" }}>
          {caption}
        </p>
      </div>
    </section>
  );
}

function ComputerCard(props: {
  computerLabel: string | null;
  canBindComputer: boolean;
  bindPending: boolean;
  onBindComputer: (() => void) | undefined;
}) {
  const bound = !!props.computerLabel;
  return (
    <section
      style={{
        background: "var(--bg-raised)",
        border: "var(--hairline) solid var(--border)",
        borderRadius: 6,
      }}
    >
      <header
        className="flex items-center justify-between"
        style={{ padding: "var(--sp-2_5) var(--sp-3_5)", borderBottom: "var(--hairline) solid var(--border-faint)" }}
      >
        <h3 className="text-body font-semibold" style={{ color: "var(--fg)" }}>
          Bound computer
        </h3>
        {props.canBindComputer && props.onBindComputer && !bound && (
          <Button size="xs" variant="outline" onClick={props.onBindComputer} disabled={props.bindPending}>
            <Link2 className="h-3 w-3" />
            {props.bindPending ? "Binding…" : "Bind computer"}
          </Button>
        )}
      </header>
      <div className="px-4 py-3 text-body">
        {bound ? (
          <div className="mono" style={{ color: "var(--fg-2)" }}>
            {props.computerLabel}
          </div>
        ) : (
          <p className="text-caption" style={{ color: "var(--fg-3)" }}>
            No computer bound. A computer claims this agent on its first WebSocket connect, or you can pick one manually
            via the button above.
          </p>
        )}
      </div>
    </section>
  );
}
