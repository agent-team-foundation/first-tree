import { ONBOARDING_STEPS } from "@agent-team-foundation/first-tree-hub-shared";
import { useEffect, useState } from "react";
import { Navigate, useNavigate } from "react-router";
import { type ConnectedClientSummary, generateConnectToken, listMyClients } from "../api/clients.js";
import { setOnboardingState } from "../api/onboarding.js";
import { useAuth } from "../auth/auth-context.js";
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
 * "Continue" persists the wizard checkpoint to `members.onboarding_state`
 * (`{ currentStep: "create_agent" }`) and navigates to `/welcome/agent`
 * — so a refresh on Step 2 doesn't fall back to Step 1 through the
 * auth-context's null state.
 *
 * Cross-workspace skip (P0-5): when the user already has a connected
 * client in some other workspace, Step 1 is redundant; we write the
 * `create_agent` checkpoint server-side and bounce to Step 2 on mount.
 */
const POLL_INTERVAL_MS = 3000;
/**
 * After this long without seeing a connected client, surface a stale-token
 * hint. The wizard can't see CLI-side failures directly (the CLI talks to
 * `/auth/connect-token`, the wizard polls `/clients/`); this approximates
 * P0-4 "失败恢复" from docs/saas-onboarding-journey.md §4.5.1 by giving
 * the user a way out when the most likely failure (token expiry) bites.
 */
const STALE_BANNER_MS = 60_000;

export function WelcomeConnectPage() {
  const navigate = useNavigate();
  const { userId, onboardingState, hasConnectedClientElsewhere, refetchAll } = useAuth();
  const [tokenResp, setTokenResp] = useState<{ token: string; command: string } | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [tokenBusy, setTokenBusy] = useState(false);
  const [clients, setClients] = useState<ConnectedClientSummary[] | null>(null);
  const [stale, setStale] = useState(false);

  // P0-5: cross-workspace skip. The user already connected a machine
  // for some other workspace they belong to — the prerequisites are
  // proven, so we shouldn't make them re-walk Step 1. Persist the
  // skip as an onboarding-state checkpoint so a refresh on this page
  // doesn't bounce them back here, then advance to Step 2. The bounce
  // happens AFTER auth-context loads (`onboardingState` is null while
  // tokens are valid but /me hasn't returned yet).
  const shouldSkipConnect = onboardingState === null && hasConnectedClientElsewhere;
  useEffect(() => {
    if (!shouldSkipConnect) return;
    void (async () => {
      try {
        await setOnboardingState({ currentStep: ONBOARDING_STEPS.CREATE_AGENT });
        await refetchAll();
      } catch {
        // Best-effort — if the write fails the user lands on Step 1
        // anyway, which is correct fallback behavior.
      }
    })();
  }, [shouldSkipConnect, refetchAll]);

  // Honour the stored checkpoint regardless of polling state.
  if (onboardingState?.currentStep === ONBOARDING_STEPS.COMPLETED) {
    return <Navigate to="/" replace />;
  }
  if (onboardingState?.currentStep === ONBOARDING_STEPS.CREATE_AGENT) {
    return <Navigate to="/welcome/agent" replace />;
  }

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
  // in this slice. Polling stops when at least one OF THE CALLER'S
  // OWN clients is connected — admins (workspace creators) can see
  // peers' clients on this endpoint, so we filter by `userId` to avoid
  // a false-positive Continue when a teammate happens to be online.
  // We also DON'T resume polling after disconnect: this is a one-shot
  // wizard; a Ctrl-C after success is the user's choice and shouldn't
  // bounce them back into the connect screen.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const list = await listMyClients();
        if (cancelled) return;
        setClients(list);
        const anyConnectedMine = list.some((c) => c.status === "connected" && c.userId === userId);
        if (!anyConnectedMine) {
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
  }, [userId]);

  // Stale-token banner — fires once after STALE_BANNER_MS if the client
  // still hasn't appeared. Cleared automatically the moment a connected
  // own-client is detected.
  useEffect(() => {
    const timer = setTimeout(() => setStale(true), STALE_BANNER_MS);
    return () => clearTimeout(timer);
  }, []);

  const connected = clients?.find((c) => c.status === "connected" && c.userId === userId) ?? null;
  // Reset the stale banner the moment we see the user's client come online.
  useEffect(() => {
    if (connected && stale) setStale(false);
  }, [connected, stale]);

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
            stale={stale && !connected}
            onRegenerate={() => {
              setTokenResp(null);
              setTokenBusy(true);
              setTokenError(null);
              setStale(false);
              void generateConnectToken()
                .then((r) => setTokenResp({ token: r.token, command: r.command }))
                .catch((err) => setTokenError(err instanceof Error ? err.message : "Could not generate token"))
                .finally(() => setTokenBusy(false));
            }}
          />
          <ConnectionStatusSection connected={connected} />
          <div className="flex justify-end">
            <Button
              disabled={!connected}
              onClick={async () => {
                // Persist the checkpoint before navigating so a refresh
                // on /welcome/agent doesn't fall back to /welcome/connect
                // through the auth-context's null `onboardingState`.
                try {
                  await setOnboardingState({ currentStep: ONBOARDING_STEPS.CREATE_AGENT });
                  await refetchAll();
                } catch {
                  // Best-effort — agent page also writes its own
                  // checkpoint after a successful create.
                }
                navigate("/welcome/agent", { replace: true });
              }}
            >
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
  stale,
  onRegenerate,
}: {
  tokenResp: { token: string; command: string } | null;
  tokenError: string | null;
  tokenBusy: boolean;
  /** True when the wizard has been waiting unusually long without seeing the client land. */
  stale: boolean;
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
          {stale && (
            <div className="rounded-md border border-border bg-card p-2 text-caption">
              Still waiting? Your token may have expired (10-minute window).{" "}
              <button type="button" className="underline" onClick={onRegenerate} disabled={tokenBusy}>
                Generate a new one
              </button>
              {" and try again."}
            </div>
          )}
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
