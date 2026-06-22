import type { RuntimeProvider } from "@first-tree/shared";
import { Link2 } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../../components/ui/button.js";
import { Section } from "../../components/ui/section.js";
import { StatusGlyph } from "../../components/ui/status-glyph.js";
import { ConfigRow } from "./flat-section.js";
import { titleWithSemantics } from "./save-semantics.js";

// Execution (computer + runtime) is the immediate-save half of the Environment
// tab. Model / reasoning (draft, SaveBar) render separately in the tab's draft
// zone — they used to be slotted in here, but PR2 splits the two save semantics
// into distinct zones, so this section is Execution-only now.
export type RuntimeSectionProps = {
  runtimeProvider: RuntimeProvider;
  /** Display label of the bound computer; null when no computer is bound yet. */
  computerLabel: string | null;
  /** Whether the bound computer is currently connected; null when unknown. */
  computerOnline?: boolean | null;
  computerStatusLoading?: boolean;
  computerStatusError?: string | null;
  /** Whether the "Bind computer" CTA should be shown (only when no client is bound and agent is active). */
  canBindComputer: boolean;
  bindComputerPending?: boolean;
  onBindComputer?: () => void;
};

const RUNTIME_NAME: Record<RuntimeProvider, string> = {
  "claude-code": "Claude Code",
  "claude-code-tui": "Claude Code CLI",
  codex: "Codex",
};

export function RuntimeSection(props: RuntimeSectionProps) {
  return (
    <Section
      title={titleWithSemantics("Execution")}
      description="Runtime is set when the agent is created; the computer is bound once and is then fixed."
    >
      <ComputerRow
        computerLabel={props.computerLabel}
        online={props.computerOnline ?? null}
        statusLoading={props.computerStatusLoading ?? false}
        statusError={props.computerStatusError ?? null}
        canBindComputer={props.canBindComputer}
        bindPending={props.bindComputerPending ?? false}
        onBindComputer={props.onBindComputer}
      />
      <RuntimeRow name={RUNTIME_NAME[props.runtimeProvider]} />
    </Section>
  );
}

// Runtime is fixed at creation, so it's a read-only label. The old per-provider
// caption just restated the value — the section subtitle already says runtime is
// fixed — so the row carries only `label: value`.
function RuntimeRow({ name }: { name: string }) {
  return <ConfigRow label="Runtime" value={name} />;
}

function ComputerRow(props: {
  computerLabel: string | null;
  online: boolean | null;
  statusLoading: boolean;
  statusError: string | null;
  canBindComputer: boolean;
  bindPending: boolean;
  onBindComputer: (() => void) | undefined;
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
    ) : null;

  let value: ReactNode = props.computerLabel;
  let description: ReactNode = null;
  if (props.statusLoading) {
    value = "Checking computer binding…";
  } else if (props.statusError) {
    value = <span style={{ color: "var(--state-error)" }}>Could not verify computer binding: {props.statusError}</span>;
  } else if (!bound) {
    value = "No computer bound";
    description = "Bind a connected computer before this agent can run.";
  } else {
    // Bound computer → show its live connection state instead of a static
    // caption that just restated "this computer runs the agent".
    description = <ComputerPresence online={props.online} />;
  }

  return <ConfigRow label="Computer" value={value} description={description} action={action} />;
}

// Live presence of the bound computer: a connected computer is "present" (blue,
// per the state map), a disconnected one is offline (gray). Unknown → nothing.
function ComputerPresence({ online }: { online: boolean | null }) {
  if (online == null) return null;
  const color = online ? "var(--state-idle)" : "var(--state-offline)";
  return (
    <span className="inline-flex items-center gap-1.5" style={{ color: "var(--fg-3)" }}>
      <StatusGlyph colorVar={color} shape="dot" size={7} ariaLabel={online ? "Online" : "Offline"} />
      {online ? "Online" : "Offline"}
    </span>
  );
}
