import type { Agent } from "@agent-team-foundation/first-tree-hub-shared";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { generateConnectToken } from "../api/activity.js";
import { getAgent } from "../api/agents.js";
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
  const [copied, setCopied] = useState(false);

  const tokenQuery = useQuery({
    queryKey: ["connect-token", agent.uuid],
    queryFn: () => generateConnectToken(),
    enabled: open,
    staleTime: 60_000,
  });

  // Poll the agent row every 2s while the modal is open and the agent is
  // still unbound. React-query stops fetching the moment the component
  // unmounts.
  const agentQuery = useQuery({
    queryKey: ["agent-poll", agent.uuid],
    queryFn: () => getAgent(agent.uuid),
    enabled: open && !agent.clientId,
    refetchInterval: 2000,
  });

  useEffect(() => {
    const latest = agentQuery.data;
    if (latest?.clientId) {
      onBound(latest);
    }
  }, [agentQuery.data, onBound]);

  // Assemble the Last-step one-liner entirely on the web side so the server
  // stays out of UI-shaped concerns (it only returns the raw `connect <token>`
  // invocation). The three segments, in order:
  //   1. `npm install -g` — bootstrap the CLI for users who've never run it
  //   2. `agent add`      — pure local file write,no auth/network;the
  //                          resulting `agent.yaml` is what the runtime picks
  //                          up on first load
  //   3. `connect <token>` — computer-level auth + launchd/systemd service;
  //                          runtime's first `loadAgents` already sees the
  //                          agent written in step 2,no watcher race
  const baseCommand = tokenQuery.data?.command ?? "";
  const command =
    baseCommand && agent.name
      ? `npm install -g @agent-team-foundation/first-tree-hub && ` +
        `first-tree-hub agent add ${shellQuote(agent.name)} --agent-id ${agent.uuid} && ` +
        baseCommand
      : baseCommand;

  function handleCopy() {
    if (!command) return;
    navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Last step — connect your computer</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-body text-muted-foreground">
            Open a terminal on your computer and run this command. It installs the First Tree Hub CLI, signs your
            computer in, and keeps it online in the background.
          </p>
          <div className="flex items-start gap-2 rounded-md border border-border bg-muted p-3">
            <code className="flex-1 text-caption font-mono break-all select-all">
              {command || "Generating command…"}
            </code>
            <Button variant="outline" size="icon" className="shrink-0" onClick={handleCopy} disabled={!command}>
              {copied ? (
                <Check className="h-4 w-4" style={{ color: "var(--state-idle)" }} />
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
