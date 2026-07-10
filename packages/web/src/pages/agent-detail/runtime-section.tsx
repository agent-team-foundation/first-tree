import type { RuntimeProvider } from "@first-tree/shared";
import { AlertTriangle, Link2, RefreshCcw } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../../components/ui/button.js";
import { Section } from "../../components/ui/section.js";
import { ConfigRow } from "./flat-section.js";
import type { RuntimeSwitchClaimView } from "./layout-context.js";
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
  canSwitchRuntime?: boolean;
  runtimeSwitchPending?: boolean;
  onSwitchRuntime?: () => void;
};

const RUNTIME_NAME: Record<RuntimeProvider, string> = {
  "claude-code": "Claude Code",
  "claude-code-tui": "Claude Code CLI",
  codex: "Codex",
  cursor: "Cursor",
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
      <RuntimeRow
        name={RUNTIME_NAME[props.runtimeProvider]}
        canSwitch={props.canSwitchRuntime ?? false}
        switchPending={props.runtimeSwitchPending ?? false}
        onSwitch={props.onSwitchRuntime}
      />
    </Section>
  );
}

export function RuntimeSwitchRecoveryNotice({
  claim,
  pending,
  error,
  onRecover,
}: {
  claim: RuntimeSwitchClaimView;
  pending: boolean;
  error: string | null;
  onRecover: () => void;
}) {
  return (
    <Section title="Runtime switch recovery">
      <div
        className="flex items-start gap-3"
        style={{
          padding: "var(--sp-3)",
          border: "var(--hairline) solid var(--state-blocked)",
          borderRadius: "var(--radius-panel)",
        }}
      >
        <AlertTriangle className="h-4 w-4 shrink-0" style={{ color: "var(--state-blocked)", marginTop: 2 }} />
        <div className="min-w-0 flex-1">
          <p className="m-0 text-body font-medium" style={{ color: "var(--fg)" }}>
            Runtime switch is waiting for recovery
          </p>
          <p className="m-0 text-caption" style={{ color: "var(--fg-3)", marginTop: "var(--sp-0_5)" }}>
            Claim {claim.claimId ?? "unknown"} is in phase {claim.phase ?? "unknown"}. Ordinary lifecycle and runtime
            edits stay locked until recovery completes.
          </p>
          {error && (
            <p className="m-0 text-caption" style={{ color: "var(--state-error)", marginTop: "var(--sp-1)" }}>
              {error}
            </p>
          )}
        </div>
        <Button size="xs" variant="outline" onClick={onRecover} disabled={pending}>
          <RefreshCcw className="h-3 w-3" />
          {pending ? "Recovering…" : "Recover"}
        </Button>
      </div>
    </Section>
  );
}

function RuntimeRow({
  name,
  canSwitch,
  switchPending,
  onSwitch,
}: {
  name: string;
  canSwitch: boolean;
  switchPending: boolean;
  onSwitch: (() => void) | undefined;
}) {
  const action =
    canSwitch && onSwitch ? (
      <Button
        size="xs"
        variant="outline"
        onClick={onSwitch}
        disabled={switchPending}
        title={switchPending ? "Switching runtime…" : "Move this agent to another runtime"}
      >
        <RefreshCcw className="h-3 w-3" />
        {switchPending ? "Switching…" : "Switch runtime"}
      </Button>
    ) : null;
  return <ConfigRow label="Runtime" value={name} action={action} />;
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
    description = "Choose a connected computer before this agent can run.";
  }
  // Bound: the computer name only. Its live online/offline state is intentionally
  // not repeated here — the page header already carries presence (and the two
  // read as redundant side by side).

  return <ConfigRow label="Computer" value={value} description={description} action={action} />;
}
