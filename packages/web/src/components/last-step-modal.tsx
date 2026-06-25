import type { Agent } from "@first-tree/shared";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy } from "lucide-react";
import { useEffect } from "react";
import { generateConnectToken } from "../api/activity.js";
import { getAgent } from "../api/agents.js";
import { useCopyFeedback } from "../lib/use-copy-feedback.js";
import { Button } from "./ui/button.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog.js";
import { StateDot } from "./ui/state-dot.js";

/**
 * Last-step modal — shown after a Claude Code agent is created.
 *
 * 1. Fetches a fresh connect token so the `curl | sh … --token` command
 *    logs the user's computer in as them (not as the agent).
 * 2. Polls the new agent's row for a `clientId` — that's how we detect
 *    the computer finished binding (see #98 + this PR's agent create
 *    path leaving `clientId` NULL until first WS bind).
 * 3. On bind, closes the modal and hands control back to the caller,
 *    which navigates to the Workspace.
 */

type Props = {
  agent: Agent;
  open: boolean;
  onClose: () => void;
  onBound: (agent: Agent) => void;
};

/**
 * Quote for a POSIX shell. Agent names are already slugified to
 * `[a-z0-9_-]`, so this is belt-and-suspenders.
 */
function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function LastStepModal({ agent, open, onClose, onBound }: Props) {
  // Shared copy → transient-feedback machine. This modal historically used a
  // slightly longer 2s window than the 1.5s default — kept as-is.
  const { status: copyStatus, copy } = useCopyFeedback({ feedbackMs: 2_000 });
  const copied = copyStatus === "copied";

  const tokenQuery = useQuery({
    queryKey: ["connect-token", agent.uuid],
    queryFn: () => generateConnectToken(),
    enabled: open,
    staleTime: 60_000,
  });

  // Poll the agent row every 5s while the modal is open and the agent is
  // still unbound. Originally 2s, but that produces 30 RPM per open modal;
  // the bind is gated on the user running a CLI command on another machine
  // (single-digit-seconds task), so a 5s cadence still feels live without
  // the request-storm. A proper push-driven path requires a new admin WS
  // frame for `agent:pinned` (today it's only routed to the Client SDK).
  // `refetchIntervalInBackground: false` skips ticks when the tab is
  // backgrounded — the modal can't make progress anyway without a foreground
  // CLI invocation, and the inevitable `refetchOnWindowFocus` will catch up
  // when the user comes back.
  const agentQuery = useQuery({
    queryKey: ["agent-poll", agent.uuid],
    queryFn: () => getAgent(agent.uuid),
    enabled: open && !agent.clientId,
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
  });

  useEffect(() => {
    const latest = agentQuery.data;
    if (latest?.clientId) {
      onBound(latest);
    }
  }, [agentQuery.data, onBound]);

  // Assemble the Last-step one-liner from the channel-aware fields the
  // server returns. The three segments, in order:
  //   1. `npm install -g <pkg>@<version>` — bootstrap the CLI for users
  //                                who've never run it. SKIPPED for dev
  //                                servers (npmSpec=null) since dev installs
  //                                from source via scripts/dev-install.sh.
  //   2. `<bin> agent add`      — pure local file write, no auth/network;
  //                                the resulting `agent.yaml` is what the
  //                                runtime picks up on first load.
  //   3. `<bin> login <token>`  — computer-level auth + launchd/systemd
  //                                service; runtime's first `loadAgents`
  //                                already sees the agent written in step
  //                                2, no watcher race.
  const baseCommand = tokenQuery.data?.command ?? "";
  const npmSpec = tokenQuery.data?.npmSpec ?? null;
  const binName = tokenQuery.data?.binName ?? "";
  const command =
    baseCommand && agent.name && binName
      ? [
          npmSpec ? `npm install -g ${npmSpec}` : null,
          `${binName} agent add ${shellQuote(agent.name)} --agent-id ${agent.uuid}`,
          baseCommand,
        ]
          .filter((part): part is string => part !== null)
          .join(" && ")
      : baseCommand;

  function handleCopy() {
    if (!command) return;
    void copy(command);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Last step — connect your computer</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-body text-muted-foreground">
            Open a terminal on your computer and run this command. It installs the First Tree CLI, signs your computer
            in, and keeps it online in the background.
          </p>
          <div className="flex items-start gap-2 rounded-[var(--radius-panel)] border border-border bg-muted p-3">
            <code className="flex-1 text-caption font-mono break-all select-all">
              {command || "Generating command…"}
            </code>
            <Button variant="outline" size="icon" className="shrink-0" onClick={handleCopy} disabled={!command}>
              {copied ? (
                <Check className="h-4 w-4" style={{ color: "var(--success)" }} />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </Button>
          </div>
          <div className="flex items-center gap-2 text-body text-muted-foreground">
            <StateDot state="working" size={8} />
            <span>Waiting for your computer to connect…</span>
          </div>
          <p className="text-caption text-muted-foreground">
            The command is good for 10 minutes. After it runs once, your computer stays online automatically — no need
            to keep this terminal open.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Skip for now
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
