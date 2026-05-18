import type { RuntimeProvider } from "@agent-team-foundation/first-tree-hub-shared";
import { Link2, Lock } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../../components/ui/button.js";
import { Section } from "../../components/ui/section.js";
import { ConfigRow } from "./flat-section.js";

/**
 * Setup section — "where it runs" pick (locked here, re-bindable via the
 * unified Re-bind dialog), bind-computer banner, and a slot for the Model
 * editor. Surfaces the runtime provider + bound computer pair in a single
 * place before the operator reaches the editable Model control below.
 */

export type SetupSectionProps = {
  runtimeProvider: RuntimeProvider;
  /** Display label of the bound computer; null when no computer is bound yet. */
  computerLabel: string | null;
  computerStatusLoading?: boolean;
  computerStatusError?: string | null;
  /** Whether the "Bind computer" CTA should be shown (only when no client is bound and agent is active). */
  canBindComputer: boolean;
  bindComputerPending?: boolean;
  onBindComputer?: () => void;
  /** When set, the bound-computer card surfaces a "Re-bind" button that
   *  opens the unified ReBindDialog (UX U2). Available only on bound agents. */
  onRebind?: () => void;
  /** Slot for the Model dropdown — we reuse the existing ModelSection via composition. */
  modelSlot: ReactNode;
};

const RUNTIME_COPY: Record<RuntimeProvider, { name: string; caption: string }> = {
  "claude-code": {
    name: "Claude Code",
    caption: "Anthropic's Claude Code runtime.",
  },
  codex: {
    name: "Codex",
    caption: "OpenAI's Codex CLI runtime.",
  },
};

export function SetupSection(props: SetupSectionProps) {
  const copy = RUNTIME_COPY[props.runtimeProvider];
  return (
    <Section title="Runtime">
      <ComputerRow
        computerLabel={props.computerLabel}
        statusLoading={props.computerStatusLoading ?? false}
        statusError={props.computerStatusError ?? null}
        canBindComputer={props.canBindComputer}
        bindPending={props.bindComputerPending ?? false}
        onBindComputer={props.onBindComputer}
        onRebind={props.onRebind}
      />
      <RuntimeRow name={copy.name} caption={copy.caption} locked />
      {props.modelSlot}
    </Section>
  );
}

function RuntimeRow({ name, caption, locked }: { name: string; caption: string; locked: boolean }) {
  return (
    <ConfigRow
      label="Provider"
      value={name}
      helpText={caption}
      meta={
        locked ? (
          <span
            className="text-caption inline-flex items-center gap-1"
            style={{ color: "var(--fg-4)" }}
            title="Re-bind via the Re-bind dialog to switch runtime"
          >
            <Lock className="h-3 w-3" aria-hidden /> Read-only
          </span>
        ) : null
      }
    />
  );
}

function ComputerRow(props: {
  computerLabel: string | null;
  statusLoading: boolean;
  statusError: string | null;
  canBindComputer: boolean;
  bindPending: boolean;
  onBindComputer: (() => void) | undefined;
  onRebind: (() => void) | undefined;
}) {
  const bound = !!props.computerLabel;
  const canShowActions = !props.statusLoading && !props.statusError;
  const action =
    canShowActions && props.canBindComputer && props.onBindComputer && !bound ? (
      <Button
        size="xs"
        variant="outline"
        onClick={props.onBindComputer}
        disabled={props.bindPending}
        title={props.bindPending ? "Binding computer…" : "Pick a connected computer for this agent"}
      >
        <Link2 className="h-3 w-3" />
        {props.bindPending ? "Binding…" : "Bind computer"}
      </Button>
    ) : canShowActions && bound && props.onRebind ? (
      <Button size="xs" variant="outline" onClick={props.onRebind} title="Move this agent to another computer">
        <Link2 className="h-3 w-3" />
        Re-bind
      </Button>
    ) : null;

  let value: ReactNode = props.computerLabel;
  // Bound state has no inline description — the hostname speaks for itself.
  // Unbound state keeps the inline guidance so new operators see it without
  // having to discover the ? tooltip.
  let description: ReactNode = null;
  let helpText: string | undefined = "The computer environment and tool access for this agent.";
  if (props.statusLoading) {
    value = "Checking computer binding…";
    helpText = undefined;
  } else if (props.statusError) {
    value = <span style={{ color: "var(--state-error)" }}>Could not verify computer binding: {props.statusError}</span>;
    helpText = undefined;
  } else if (!bound) {
    value = "No computer bound";
    description = "A computer claims this agent on first WebSocket connect, or you can pick one manually.";
    helpText = undefined;
  }

  return <ConfigRow label="Computer" value={value} description={description} helpText={helpText} action={action} />;
}
