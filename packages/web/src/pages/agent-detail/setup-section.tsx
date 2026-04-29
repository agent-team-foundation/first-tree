import type { RuntimeProvider } from "@agent-team-foundation/first-tree-hub-shared";
import { Link2, Lock, Play } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../../components/ui/button.js";
import { Panel, PanelBody, PanelHeader, PanelTitle } from "../../components/ui/panel.js";

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
    caption: "Anthropic's Claude Code runtime. Re-bind via the agent's settings to switch computer or runtime.",
  },
  codex: {
    name: "Codex",
    caption: "OpenAI's Codex CLI runtime. Re-bind via the agent's settings to switch computer or runtime.",
  },
};

export function SetupSection(props: SetupSectionProps) {
  const copy = RUNTIME_COPY[props.runtimeProvider];
  return (
    <div className="space-y-3">
      <RuntimeCard name={copy.name} caption={copy.caption} locked />

      <ComputerCard
        computerLabel={props.computerLabel}
        canBindComputer={props.canBindComputer}
        bindPending={props.bindComputerPending ?? false}
        onBindComputer={props.onBindComputer}
        onRebind={props.onRebind}
      />

      {props.modelSlot}
    </div>
  );
}

function RuntimeCard({ name, caption, locked }: { name: string; caption: string; locked: boolean }) {
  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>
          Where it runs
          {locked && (
            <span
              className="mono uppercase text-caption inline-flex items-center gap-1"
              style={{ color: "var(--fg-4)" }}
            >
              <Lock className="h-3 w-3" aria-hidden /> locked
            </span>
          )}
        </PanelTitle>
      </PanelHeader>
      <PanelBody className="space-y-1 text-body">
        <div className="inline-flex items-center gap-2">
          <Play className="h-3.5 w-3.5" aria-hidden style={{ color: "var(--accent)" }} />
          <span className="font-medium">{name}</span>
        </div>
        <p className="text-caption" style={{ color: "var(--fg-3)" }}>
          {caption}
        </p>
      </PanelBody>
    </Panel>
  );
}

function ComputerCard(props: {
  computerLabel: string | null;
  canBindComputer: boolean;
  bindPending: boolean;
  onBindComputer: (() => void) | undefined;
  onRebind: (() => void) | undefined;
}) {
  const bound = !!props.computerLabel;
  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>Bound computer</PanelTitle>
        {props.canBindComputer && props.onBindComputer && !bound && (
          <Button size="xs" variant="outline" onClick={props.onBindComputer} disabled={props.bindPending}>
            <Link2 className="h-3 w-3" />
            {props.bindPending ? "Binding…" : "Bind computer"}
          </Button>
        )}
        {bound && props.onRebind && (
          <Button size="xs" variant="outline" onClick={props.onRebind}>
            <Link2 className="h-3 w-3" />
            Re-bind
          </Button>
        )}
      </PanelHeader>
      <PanelBody className="text-body">
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
      </PanelBody>
    </Panel>
  );
}
