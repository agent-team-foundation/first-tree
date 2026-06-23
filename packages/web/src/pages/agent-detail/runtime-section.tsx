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
};

const RUNTIME_NAME: Record<RuntimeProvider, string> = {
  "claude-code": "Claude Code",
  "claude-code-tui": "Claude Code CLI",
  codex: "Codex",
};

export function RuntimeSection(props: RuntimeSectionProps) {
  return (
    <Section title={titleWithSemantics("Execution")}>
      <ComputerRow
        computerLabel={props.computerLabel}
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

// Runtime is fixed at creation, so it's a read-only label.
function RuntimeRow({ name }: { name: string }) {
  return <ConfigRow label="Runtime" value={name} />;
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
  }
  // Bound: the computer name only. Its live online/offline state is intentionally
  // not repeated here — the page header already carries presence (and the two
  // read as redundant side by side).

  return <ConfigRow label="Computer" value={value} description={description} action={action} />;
}
