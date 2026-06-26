import { CheckCircle2, Copy, Github, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { kickoffOnboarding, reportOnboardingEvent } from "../../api/onboarding-events.js";
import { useAuth } from "../../auth/auth-context.js";
import { Button } from "../../components/ui/button.js";
import { useAgentCreation } from "../onboarding/use-agent-creation.js";
import { useComputerConnection } from "../onboarding/use-computer-connection.js";
import { buildProductionScanBootstrap } from "../workspace/center/onboarding/bootstrap-prose.js";
import {
  clearProductionScanIntent,
  deriveRepoAgentDisplayName,
  type ProductionScanIntent,
  readProductionScanIntent,
} from "./intent.js";

function buildSetupPrompt(intent: ProductionScanIntent, cliCommand: string | null): string {
  return [
    "Set up First Tree for this production scan.",
    "",
    cliCommand ?? "Open First Tree and connect this computer.",
    "",
    "After the computer is connected, verify local GitHub access:",
    `gh repo clone ${intent.repoSlug}`,
    "",
    "If gh is not installed, help me install it or use my existing git credentials/local clone.",
  ].join("\n");
}

export function ProductionScanStartPage() {
  const navigate = useNavigate();
  const { organizationId } = useAuth();
  const intent = readProductionScanIntent();
  const computer = useComputerConnection(true);
  const [readyAgentUuid, setReadyAgentUuid] = useState<string | null>(null);
  const [kickoffError, setKickoffError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const createStartedRef = useRef(false);
  const kickoffStartedRef = useRef(false);
  const agent = useAgentCreation((uuid) => setReadyAgentUuid(uuid));
  const activeAgentUuid = readyAgentUuid ?? (agent.phase === "online" ? agent.createdUuid : null);

  const setupPrompt = useMemo(
    () => (intent ? buildSetupPrompt(intent, computer.cliCommand) : ""),
    [intent, computer.cliCommand],
  );

  useEffect(() => {
    if (!intent || createStartedRef.current) return;
    if (!computer.connectedClient || !computer.selectedRuntime || agent.phase !== "idle") return;
    createStartedRef.current = true;
    void agent.create({
      displayName: deriveRepoAgentDisplayName(intent.repo),
      clientId: computer.connectedClient.id,
      runtimeProvider: computer.selectedRuntime,
      visibility: "private",
      organizationId,
    });
  }, [agent, computer.connectedClient, computer.selectedRuntime, intent, organizationId]);

  const startKickoff = useCallback(async () => {
    if (!intent || !activeAgentUuid || kickoffStartedRef.current) return;
    kickoffStartedRef.current = true;
    setKickoffError(null);
    try {
      const { chatId } = await kickoffOnboarding({
        ...(organizationId ? { organizationId } : {}),
        agentUuid: activeAgentUuid,
        bootstrap: buildProductionScanBootstrap({
          repoUrl: intent.url,
          agentDisplayName: deriveRepoAgentDisplayName(intent.repo),
        }),
        kind: "production_scan",
        complete: true,
      });
      await reportOnboardingEvent("production_scan_kickoff_started", {
        agentUuid: activeAgentUuid,
        chatId,
      });
      clearProductionScanIntent();
      navigate(`/?c=${encodeURIComponent(chatId)}`);
    } catch (err) {
      setKickoffError(err instanceof Error ? err.message : "Could not start the production scan");
    }
  }, [activeAgentUuid, intent, navigate, organizationId]);

  useEffect(() => {
    void startKickoff();
  }, [startKickoff]);

  async function copySetupPrompt(): Promise<void> {
    await navigator.clipboard?.writeText(setupPrompt);
    setCopied(true);
    if (intent) {
      void reportOnboardingEvent("production_scan_setup_prompt_copied", {
        repoHost: "github.com",
      });
    }
  }

  if (!intent) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4 text-foreground">
        <div className="max-w-md rounded-[var(--radius-panel)] border border-border bg-card p-5">
          <h1 className="text-title">Paste a GitHub repo URL</h1>
          <p className="mt-2 text-body text-fg-2">
            Start from the production scan landing page so First Tree knows which repo to inspect.
          </p>
          <Button asChild className="mt-4">
            <a href="https://first-tree.ai/production-scan">Go to production scan</a>
          </Button>
        </div>
      </div>
    );
  }

  const connected = !!computer.connectedClient;
  const creating = agent.phase === "creating";
  const online = !!activeAgentUuid;

  return (
    <div className="min-h-screen bg-background px-5 py-6 text-foreground">
      <main className="mx-auto grid min-h-[calc(100vh-3rem)] max-w-4xl content-center gap-6">
        <div>
          <div className="inline-flex items-center gap-2 rounded-[var(--radius-input)] border border-border px-3 py-1 text-label text-fg-2">
            <Github className="h-3.5 w-3.5" />
            {intent.repoSlug}
          </div>
          <h1 className="mt-4 text-[2.5rem] font-semibold leading-tight tracking-normal">
            Connecting your production scan
          </h1>
          <p className="mt-2 max-w-2xl text-body text-fg-2">
            First Tree uses your local computer for private repo access, creates a private agent, then opens a
            production-readiness thread.
          </p>
        </div>

        <section className="grid gap-4 rounded-[var(--radius-panel)] border border-border bg-card p-5">
          <div className="flex items-center gap-3">
            {connected ? (
              <CheckCircle2 className="h-5 w-5" style={{ color: "var(--success)" }} />
            ) : (
              <Loader2 className="h-5 w-5 animate-spin text-fg-3" />
            )}
            <div>
              <div className="text-body font-medium">Connect local computer</div>
              <div className="text-label text-fg-3">
                {connected ? "Computer connected" : "Copy this setup prompt to Claude Code or Codex"}
              </div>
            </div>
          </div>

          {!connected ? (
            <div className="space-y-3">
              <pre className="max-h-64 overflow-auto rounded-[var(--radius-input)] border border-border bg-background p-3 text-label text-fg-2">
                {setupPrompt}
              </pre>
              <Button type="button" variant="outline" onClick={() => void copySetupPrompt()}>
                <Copy className="h-4 w-4" />
                {copied ? "Copied" : "Copy setup prompt"}
              </Button>
            </div>
          ) : null}

          <div className="flex items-center gap-3 border-t border-border pt-4">
            {online ? (
              <CheckCircle2 className="h-5 w-5" style={{ color: "var(--success)" }} />
            ) : (
              <Loader2 className="h-5 w-5 animate-spin text-fg-3" />
            )}
            <div>
              <div className="text-body font-medium">Create private scan agent</div>
              <div className="text-label text-fg-3">
                {online
                  ? "Agent online"
                  : creating
                    ? "Creating agent"
                    : "Waiting for a ready Claude Code or Codex runtime"}
              </div>
            </div>
          </div>

          {kickoffError ? (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-label" style={{ color: "var(--fg-error-strong)" }}>
                {kickoffError}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  kickoffStartedRef.current = false;
                  void startKickoff();
                }}
              >
                Retry
              </Button>
            </div>
          ) : null}
        </section>
      </main>
    </div>
  );
}
