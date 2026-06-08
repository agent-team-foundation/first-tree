import type { RuntimeProvider } from "@first-tree/shared";
import { Link2 } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../../components/ui/button.js";
import { Section } from "../../components/ui/section.js";
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
  computerStatusLoading?: boolean;
  computerStatusError?: string | null;
  /** Whether the "Bind computer" CTA should be shown (only when no client is bound and agent is active). */
  canBindComputer: boolean;
  bindComputerPending?: boolean;
  onBindComputer?: () => void;
  /** When set, the bound-computer card surfaces a "Re-bind" button that
   *  opens the unified ReBindDialog (UX U2). Available only on bound agents. */
  onRebind?: () => void;
};

const RUNTIME_COPY: Record<RuntimeProvider, { name: string; caption: string }> = {
  "claude-code": {
    name: "Claude Code",
    caption: "Runs through Anthropic's Claude Code runtime.",
  },
  "claude-code-tui": {
    name: "Claude Code (TUI)",
    caption: "Runs Claude Code through tmux for terminal-native sessions.",
  },
  codex: {
    name: "Codex",
    caption: "Runs through OpenAI's Codex CLI runtime.",
  },
};

export function RuntimeSection(props: RuntimeSectionProps) {
  const copy = RUNTIME_COPY[props.runtimeProvider];
  return (
    <Section
      title={titleWithSemantics("Execution", "immediate")}
      description="Computer and runtime changes apply immediately through bind or re-bind."
      action={
        props.computerLabel && props.onRebind ? (
          <Button
            size="xs"
            variant="outline"
            onClick={props.onRebind}
            title="Move this agent to another computer or runtime"
          >
            <Link2 className="h-3 w-3" />
            Re-bind
          </Button>
        ) : null
      }
    >
      <ComputerRow
        computerLabel={props.computerLabel}
        statusLoading={props.computerStatusLoading ?? false}
        statusError={props.computerStatusError ?? null}
        canBindComputer={props.canBindComputer}
        bindPending={props.bindComputerPending ?? false}
        onBindComputer={props.onBindComputer}
      />
      <RuntimeRow name={copy.name} caption={copy.caption} />
    </Section>
  );
}

function RuntimeRow({ name, caption }: { name: string; caption: string }) {
  return <ConfigRow label="Runtime" value={name} description={caption} />;
}

function ComputerRow(props: {
  computerLabel: string | null;
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
    description = "Runtime process and local tool access come from this computer.";
  }

  return <ConfigRow label="Computer" value={value} description={description} action={action} />;
}
