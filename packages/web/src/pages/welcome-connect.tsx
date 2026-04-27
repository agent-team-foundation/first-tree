import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { type ConnectedClientSummary, generateConnectToken, listMyClients } from "../api/clients.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.js";
import { StateDot } from "../components/ui/state-dot.js";

/**
 * `/welcome/connect` — first wizard screen per design doc §4.5.1.
 *
 * Three things on this screen:
 *   1. Prerequisite checklist (manual: node + claude + claude auth).
 *      The check is a copy-and-run shell snippet rather than a CLI
 *      sub-command call — keeps the wizard portable across OSes
 *      without us shelling out from the browser.
 *   2. The one-line `first-tree-hub connect <url> --token <…>` command
 *      with a Copy button. Token comes from `POST /me/connect-tokens`
 *      and is single-use; we re-mint on demand if the user clicks
 *      "Generate a new token".
 *   3. Live polling of `/api/v1/clients` every 3s to detect that the
 *      command landed. When `clients.length > 0 && status=="connected"`
 *      we flip a checkmark and enable "Continue".
 *
 * "Continue" navigates to the workspace shell (`/`) until PR #5 wires
 * the second wizard screen at `/welcome/agent` and onboarding-state
 * persistence. Today an empty workspace lands the user on the same
 * shell as a fully-configured one.
 */
const POLL_INTERVAL_MS = 3000;

export function WelcomeConnectPage() {
  const navigate = useNavigate();
  const [tokenResp, setTokenResp] = useState<{ token: string; command: string } | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [tokenBusy, setTokenBusy] = useState(false);
  const [clients, setClients] = useState<ConnectedClientSummary[] | null>(null);

  // Mint the first connect token on mount. The token expires in 10
  // minutes (CONNECT_TOKEN_EXPIRY in services/auth.ts) — if the user
  // dawdles past that, the command will 401; we surface a "Generate
  // a new token" affordance so they can recover without leaving the
  // page.
  useEffect(() => {
    let cancelled = false;
    void mintToken();
    return () => {
      cancelled = true;
    };

    async function mintToken() {
      setTokenBusy(true);
      setTokenError(null);
      try {
        const resp = await generateConnectToken();
        if (!cancelled) setTokenResp({ token: resp.token, command: resp.command });
      } catch (err) {
        if (!cancelled) setTokenError(err instanceof Error ? err.message : "Could not generate token");
      } finally {
        if (!cancelled) setTokenBusy(false);
      }
    }
  }, []);

  // Poll the clients list. We don't WS-subscribe because the existing
  // admin WS doesn't push `client:connected` to the wizard's session,
  // and threading that through is more risk than the wizard warrants
  // in this slice. Polling stops when at least one connected client
  // appears — once detected, no further polls are scheduled.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const list = await listMyClients();
        if (cancelled) return;
        setClients(list);
        const anyConnected = list.some((c) => c.status === "connected");
        if (!anyConnected) {
          timer = setTimeout(poll, POLL_INTERVAL_MS);
        }
      } catch {
        // Transient — try again on the next tick rather than blowing up
        // the whole wizard. Errors are common while a fresh `connect`
        // is racing the server's first registration write.
        if (!cancelled) timer = setTimeout(poll, POLL_INTERVAL_MS);
      }
    };
    void poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const connected = clients?.find((c) => c.status === "connected") ?? null;

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <CardTitle className="text-title">Connect your computer</CardTitle>
          <CardDescription>
            First Tree Hub runs your agents on your own machine via the agent CLI (Claude Code today; Codex and others
            coming soon). One-time setup below.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <PrerequisiteSection />
          <ConnectCommandSection
            tokenResp={tokenResp}
            tokenError={tokenError}
            tokenBusy={tokenBusy}
            onRegenerate={() => {
              setTokenResp(null);
              setTokenBusy(true);
              setTokenError(null);
              void generateConnectToken()
                .then((r) => setTokenResp({ token: r.token, command: r.command }))
                .catch((err) => setTokenError(err instanceof Error ? err.message : "Could not generate token"))
                .finally(() => setTokenBusy(false));
            }}
          />
          <ConnectionStatusSection connected={connected} />
          <div className="flex justify-end">
            <Button disabled={!connected} onClick={() => navigate("/", { replace: true })}>
              Continue
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function PrerequisiteSection() {
  return (
    <section className="space-y-3">
      <h3 className="text-body font-medium">1. Check prerequisites</h3>
      <p className="text-caption text-muted-foreground">
        On macOS or Linux. Windows not supported in this milestone — use WSL.
      </p>
      <CodeBlock value={"node -v && claude --version && claude auth status"} />
      <p className="text-caption text-muted-foreground">
        All three should print without errors. Missing either? Install Node 20+ from{" "}
        <a className="underline" href="https://nodejs.org" target="_blank" rel="noreferrer">
          nodejs.org
        </a>
        , then{" "}
        <a
          className="underline"
          href="https://docs.anthropic.com/claude/docs/claude-code"
          target="_blank"
          rel="noreferrer"
        >
          Claude Code
        </a>
        .
      </p>
    </section>
  );
}

function ConnectCommandSection({
  tokenResp,
  tokenError,
  tokenBusy,
  onRegenerate,
}: {
  tokenResp: { token: string; command: string } | null;
  tokenError: string | null;
  tokenBusy: boolean;
  onRegenerate: () => void;
}) {
  return (
    <section className="space-y-3">
      <h3 className="text-body font-medium">2. Run this command in a terminal</h3>
      {tokenBusy && !tokenResp ? (
        <div className="text-caption text-muted-foreground">Generating one-time token…</div>
      ) : tokenError ? (
        <div className="space-y-2">
          <div className="rounded-md bg-destructive/10 p-2 text-body text-destructive">{tokenError}</div>
          <Button variant="outline" size="sm" onClick={onRegenerate} disabled={tokenBusy}>
            Try again
          </Button>
        </div>
      ) : tokenResp ? (
        <>
          <CodeBlock value={tokenResp.command} />
          <p className="text-caption text-muted-foreground">
            Token expires in 10 minutes. Trouble?{" "}
            <button type="button" className="underline" onClick={onRegenerate} disabled={tokenBusy}>
              Generate a new one
            </button>
            .
          </p>
        </>
      ) : null}
    </section>
  );
}

function ConnectionStatusSection({ connected }: { connected: ConnectedClientSummary | null }) {
  return (
    <section className="space-y-2">
      <h3 className="text-body font-medium">3. Wait for connection</h3>
      {connected ? (
        <div className="flex items-center gap-2 rounded-md border border-border bg-card p-3">
          <StateDot state="idle" />
          <div className="text-body">
            Connected{connected.hostname ? ` from ${connected.hostname}` : ""}
            {connected.os ? ` (${connected.os})` : ""}.
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded-md border border-border bg-card p-3">
          <StateDot state="working" />
          <div className="text-body text-muted-foreground">Waiting for your computer to register…</div>
        </div>
      )}
    </section>
  );
}

function CodeBlock({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API blocked (insecure context, missing permission) —
      // fall back silently; the user can still select and copy.
    }
  };
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-md bg-[color:var(--bg-sunken)] p-3 text-caption font-mono">
        <code>{value}</code>
      </pre>
      <Button type="button" variant="outline" size="sm" className="absolute right-2 top-2" onClick={onCopy}>
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}
