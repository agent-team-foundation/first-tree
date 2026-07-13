import type { GithubAppConnectPanelInstallation, GithubAppInstallationOutput } from "@first-tree/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Building2, ChevronRight, ExternalLink, PauseCircle, User } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { ApiError } from "../api/client.js";
import {
  connectGithubAppInstallation,
  disconnectGithubAppInstallation,
  getGithubAppConnectPanel,
  getGithubAppInstallation,
  getGithubAppInstallUrl,
} from "../api/github-app.js";
import { useAuth } from "../auth/auth-context.js";
import { Button } from "../components/ui/button.js";

/**
 * Per-tab marker set when the admin kicks off an install. It locks the CTA (a
 * second mint would overwrite the first attempt's `oauth_state_nonce` cookie and
 * break its callback) and gates the "waiting for GitHub" affordance. Cleared once
 * a connectable installation shows up in the panel. Mirrors the connect-code /
 * Context-build entries, which use the same open-popup-in-a-new-tab-then-poll flow.
 */
const INSTALL_ATTEMPT_KEY = "settings:github:install-attempt";

/**
 * How often the open connect panel refreshes its installation list. Two
 * seconds keeps the owner-approval flow tight (the approved installation
 * pops in without a manual refresh); `refetchIntervalInBackground` stays
 * false so an unfocused tab stops polling and resumes on focus.
 */
const CONNECT_PANEL_POLL_MS = 2000;

/**
 * Settings → GitHub. Two surfaces:
 *
 *   - **Summary** (default) — bound: the connected account card with a
 *     "Manage connection" entry into the panel; unbound: a prominent
 *     "Connect GitHub" CTA straight into the panel.
 *   - **Connect panel** — where every binding decision happens. It can
 *     start a GitHub install (new tab), and it polls the caller's
 *     associated installations every 2s while open: connectable ones get
 *     a Connect button, this team's connection gets Disconnect, and
 *     installations connected to other First Tree teams show which team
 *     holds them. Binding is always an explicit click here — installs
 *     never auto-connect.
 */
export function GithubAppInstallationPanel({ readOnly = false }: { readOnly?: boolean }) {
  const { organizationId } = useAuth();
  const [panelOpen, setPanelOpen] = useState(false);

  const installationQuery = useQuery({
    queryKey: ["github-app-installation", organizationId],
    queryFn: () => (organizationId ? getGithubAppInstallation(organizationId) : Promise.reject(new Error("no org"))),
    enabled: !!organizationId,
    // While the connect panel is open, connections happen there (connect /
    // disconnect / an uninstall webhook landing) — keep the summary's source
    // query fresh on the same cadence so closing the panel never shows a
    // stale card.
    refetchInterval: panelOpen ? CONNECT_PANEL_POLL_MS : false,
  });

  if (installationQuery.isLoading) {
    return (
      <div className="text-body" style={{ color: "var(--fg-3)" }}>
        Loading…
      </div>
    );
  }
  if (installationQuery.error) {
    return (
      <div className="text-body" style={{ color: "var(--state-error)" }}>
        {installationQuery.error instanceof Error ? installationQuery.error.message : "Failed to load installation"}
      </div>
    );
  }

  if (panelOpen) {
    return (
      <ConnectPanel
        organizationId={organizationId}
        bound={installationQuery.data ?? null}
        onBack={() => setPanelOpen(false)}
      />
    );
  }

  // `null` (404 — no install bound) and `undefined` (query disabled because
  // organizationId hasn't loaded) both render the empty state; the loading
  // branch above already caught the in-flight case.
  if (installationQuery.data == null) {
    return (
      <NotConnectedSummary disabled={!organizationId} readOnly={readOnly} onOpenPanel={() => setPanelOpen(true)} />
    );
  }
  return <InstalledState data={installationQuery.data} readOnly={readOnly} onOpenPanel={() => setPanelOpen(true)} />;
}

/**
 * Unbound summary: the team has no GitHub connection yet, so the whole
 * surface is one prominent entry point into the connect panel.
 */
function NotConnectedSummary({
  disabled,
  readOnly,
  onOpenPanel,
}: {
  disabled: boolean;
  readOnly: boolean;
  onOpenPanel: () => void;
}) {
  return (
    <div>
      <p className="text-body" style={{ color: "var(--fg-2)", marginBottom: "var(--sp-3)" }}>
        This team isn't connected to GitHub yet. Connect a GitHub App installation to start receiving issues, pull
        requests, and reviews as routed messages.
      </p>
      {!readOnly && (
        <Button type="button" size="sm" onClick={onOpenPanel} disabled={disabled}>
          Connect GitHub
        </Button>
      )}
    </div>
  );
}

/**
 * Render a GitHub account as `github.com/<login>` — the full-path form
 * disambiguates GitHub orgs from First Tree team names (both are otherwise
 * bare words like "agent-team-foundation").
 */
function githubAccountPath(login: string): string {
  return `github.com/${login}`;
}

function InstalledState({
  data,
  readOnly,
  onOpenPanel,
}: {
  data: GithubAppInstallationOutput;
  readOnly: boolean;
  onOpenPanel: () => void;
}) {
  const AccountIcon = data.accountType === "Organization" ? Building2 : User;
  return (
    // No borderTop of its own: the page's Section frame already draws the
    // rule above this block.
    <div
      style={{
        paddingTop: "var(--sp-1)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--sp-4)",
      }}
    >
      {data.suspended && <SuspendedBanner />}

      <div>
        <div className="text-label" style={{ color: "var(--fg-3)", marginBottom: "var(--sp-1)" }}>
          Connected to
        </div>
        <div className="flex items-center" style={{ gap: "var(--sp-2)" }}>
          <AccountIcon className="h-4 w-4" style={{ color: "var(--fg-2)" }} />
          <span className="text-body font-medium" style={{ color: "var(--fg)" }}>
            {githubAccountPath(data.accountLogin)}
          </span>
          <span className="text-caption" style={{ color: "var(--fg-3)" }}>
            {data.accountType}
          </span>
        </div>
        {/* Expandable details sit directly under the connected account they
            describe, not below the action buttons. */}
        <div style={{ marginTop: "var(--sp-3)" }}>
          <ConnectionDetails data={data} />
        </div>
      </div>

      {!readOnly && (
        <div className="flex items-center" style={{ gap: "var(--sp-2)", flexWrap: "wrap" }}>
          <Button type="button" variant="outline" size="sm" onClick={onOpenPanel}>
            Manage connection
          </Button>
          <Button asChild variant="outline" size="sm">
            <a href={data.manageUrl} target="_blank" rel="noreferrer">
              Manage on GitHub
              <ExternalLink className="h-3 w-3" />
            </a>
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * The connect panel, presented as the two steps of the real-world flow:
 * Step 1 installs the App on GitHub (or, once this team is connected,
 * offers Reinstall + Manage on GitHub), Step 2 connects a recorded
 * installation to this team. The installation list is polled every 2s
 * while the panel is open (paused while the tab is unfocused, courtesy
 * of react-query's default
 * `refetchIntervalInBackground: false`). Polling deliberately continues
 * after a successful connect — new installations can still arrive (another
 * org's owner approving, an install made directly on GitHub), and the
 * panel should surface them the moment they exist.
 */
function ConnectPanel({
  organizationId,
  bound,
  onBack,
}: {
  organizationId: string | null;
  /** The installation currently connected to this team (summary query), or null. */
  bound: GithubAppInstallationOutput | null;
  onBack: () => void;
}) {
  const queryClient = useQueryClient();

  const panelQuery = useQuery({
    queryKey: ["github-app-connect-panel", organizationId],
    queryFn: () => (organizationId ? getGithubAppConnectPanel(organizationId) : Promise.reject(new Error("no org"))),
    enabled: !!organizationId,
    refetchInterval: CONNECT_PANEL_POLL_MS,
  });

  const installations = panelQuery.data?.installations ?? [];
  const connectable = installations.filter((i) => i.status === "connectable");

  // Install-attempt marker: locks the install CTA and shows the waiting
  // affordance until something connectable appears (the thing to click next).
  const [attempted, setAttempted] = useState(
    () => typeof window !== "undefined" && !!window.sessionStorage.getItem(INSTALL_ATTEMPT_KEY),
  );
  useEffect(() => {
    if (attempted && connectable.length > 0 && typeof window !== "undefined") {
      window.sessionStorage.removeItem(INSTALL_ATTEMPT_KEY);
      setAttempted(false);
    }
  }, [attempted, connectable.length]);

  // The install URL is minted on click (not preloaded): the server signs a
  // `state` JWT and sets the matching `oauth_state_nonce` cookie before handing
  // back the `installations/new?state=…` URL, and both expire after 10 minutes.
  // Minting at click time keeps them fresh (codex P2 follow-up).
  const installUrlMutation = useMutation({
    mutationFn: (next: string | undefined) => {
      if (!organizationId) throw new Error("No organization selected");
      return getGithubAppInstallUrl(organizationId, next);
    },
  });

  const handleInstall = (): void => {
    if (!organizationId) return;
    // Open the tab synchronously inside the click gesture so the browser doesn't
    // treat the post-await open as a blocked popup; fill its location once the
    // URL is minted, or close it on failure. GitHub installs in that tab and
    // lands it on the self-closing /onboarding/connected page, while this tab
    // keeps polling and surfaces the new installation as connectable. The nonce
    // cookie is set on this tab's XHR but shared across tabs, so it rides along
    // to GitHub's callback in the new tab.
    const installTab = window.open("", "_blank");
    // Popup opened → the new tab returns to the self-closing connected page;
    // popup blocked → the full-page redirect must return THIS tab to Settings →
    // GitHub (undefined lets the server apply its `/settings/github` default).
    const next = installTab ? "/onboarding/connected" : undefined;
    installUrlMutation.mutate(next, {
      onSuccess: (installUrl) => {
        window.sessionStorage.setItem(INSTALL_ATTEMPT_KEY, String(Date.now()));
        setAttempted(true);
        if (installTab) installTab.location.href = installUrl;
        else window.location.assign(installUrl); // popup blocked — full redirect
      },
      onError: () => installTab?.close(),
    });
  };

  // Explicit re-mint after a stuck install (GitHub tab closed without
  // installing): a fresh URL overwrites the nonce cookie, so retry is a
  // conscious action, never an auto re-click while the first tab may be mid-flow.
  const handleStartOver = (): void => {
    window.sessionStorage.removeItem(INSTALL_ATTEMPT_KEY);
    setAttempted(false);
    installUrlMutation.reset();
  };

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["github-app-connect-panel", organizationId] });
    void queryClient.invalidateQueries({ queryKey: ["github-app-installation", organizationId] });
  };

  const connectMutation = useMutation({
    mutationFn: (installationId: number) => {
      if (!organizationId) throw new Error("No organization selected");
      return connectGithubAppInstallation(organizationId, installationId);
    },
    onSettled: invalidate,
  });

  const disconnectMutation = useMutation({
    mutationFn: () => {
      if (!organizationId) throw new Error("No organization selected");
      return disconnectGithubAppInstallation(organizationId);
    },
    onSettled: invalidate,
  });

  const slugMissing = installUrlMutation.error instanceof ApiError && installUrlMutation.error.status === 503;
  const installDisabled = !organizationId || installUrlMutation.isPending || attempted;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
      <div>
        <Button type="button" variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft aria-hidden className="h-3 w-3" />
          Back
        </Button>
      </div>

      {/* ── Step 1: get the App installed on GitHub ──────────────────── */}
      <div>
        <div className="text-body font-semibold" style={{ color: "var(--fg)", marginBottom: "var(--sp-2)" }}>
          Step 1: Install the First Tree App on your GitHub
        </div>
        {slugMissing ? (
          <p className="text-body" style={{ color: "var(--state-error)", margin: 0 }}>
            The GitHub App slug isn't configured on this First Tree deployment. Ask your operator to set{" "}
            <code className="mono">FIRST_TREE_GITHUB_APP_SLUG</code>.
          </p>
        ) : bound ? (
          // This team already has a connected installation, so Step 1 is done —
          // surface that state instead of a primary CTA. Reinstall kicks off a
          // fresh install (e.g. on another GitHub account); Manage on GitHub
          // opens the installed App's own settings page.
          <div className="flex items-center" style={{ gap: "var(--sp-2_5)", flexWrap: "wrap" }}>
            <span className="text-body" style={{ color: "var(--fg-2)" }}>
              GitHub App installed.
            </span>
            <Button type="button" variant="outline" size="sm" onClick={handleInstall} disabled={installDisabled}>
              {installUrlMutation.isPending ? "Opening GitHub…" : "Reinstall"}
            </Button>
            <Button asChild variant="outline" size="sm">
              <a href={bound.manageUrl} target="_blank" rel="noreferrer">
                Manage on GitHub
                <ExternalLink className="h-3 w-3" />
              </a>
            </Button>
          </div>
        ) : (
          // Button (not anchor) because the install URL is minted on click,
          // then a synchronously-opened new tab is navigated to it — keeps the
          // state JWT + nonce cookie fresh and the popup unblocked.
          <Button type="button" size="sm" onClick={handleInstall} disabled={installDisabled}>
            {installUrlMutation.isPending ? "Opening GitHub…" : "Install on GitHub"}
            <ExternalLink className="h-3 w-3" />
          </Button>
        )}
        {installUrlMutation.error && !slugMissing && (
          <p className="text-body" style={{ color: "var(--state-error)", marginTop: "var(--sp-2)" }}>
            {installUrlMutation.error instanceof Error
              ? installUrlMutation.error.message
              : "Failed to build the install URL"}
          </p>
        )}
      </div>

      {/* ── Step 2: connect a recorded installation to this team ─────── */}
      <div>
        <div className="text-body font-semibold" style={{ color: "var(--fg)", marginBottom: "var(--sp-2)" }}>
          Step 2: Connect to your GitHub
        </div>
        {/* After the install tab opens, this panel's poll picks the
            installation up as connectable. If the GitHub tab didn't work,
            "Start over" re-mints (the only safe retry — see handleStartOver). */}
        {attempted && !installUrlMutation.isPending && (
          <div
            className="flex items-center"
            style={{ gap: "var(--sp-2_5)", marginBottom: "var(--sp-2)", flexWrap: "wrap" }}
          >
            <span className="text-label" style={{ color: "var(--fg-3)" }}>
              Waiting for GitHub… You may need a GitHub org admin to approve.
            </span>
            <Button type="button" variant="link" size="sm" onClick={handleStartOver}>
              Didn't work? Start over
            </Button>
          </div>
        )}
      </div>

      {panelQuery.error && (
        <p className="text-body" style={{ color: "var(--state-error)", margin: 0 }}>
          {panelQuery.error instanceof Error ? panelQuery.error.message : "Failed to load installations"}
        </p>
      )}
      {connectMutation.error && (
        <p className="text-body" style={{ color: "var(--state-error)", margin: 0 }}>
          {connectError(connectMutation.error)}
        </p>
      )}
      {disconnectMutation.error && (
        <p className="text-body" style={{ color: "var(--state-error)", margin: 0 }}>
          {disconnectMutation.error instanceof Error ? disconnectMutation.error.message : "Failed to disconnect"}
        </p>
      )}

      <InstallationGroup label="Available to connect">
        {!panelQuery.isLoading && installations.length === 0 ? (
          <p className="text-body" style={{ color: "var(--fg-3)", margin: 0 }}>
            No installations are linked to your GitHub account yet. Install the App above, or ask the teammate who
            installed it to connect it from their panel.
          </p>
        ) : (
          installations.map((installation) => (
            <InstallationRow key={installation.installationId} installation={installation}>
              <InstallationAction
                installation={installation}
                connectMutation={connectMutation}
                disconnectMutation={disconnectMutation}
              />
            </InstallationRow>
          ))
        )}
      </InstallationGroup>
    </div>
  );
}

function connectError(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) {
    return "This connection isn't possible: either the installation is already connected to another team, or this team already has a connection. Disconnect first, then retry.";
  }
  return error instanceof Error ? error.message : "Failed to connect";
}

function InstallationGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ borderTop: "var(--hairline) solid var(--border)", paddingTop: "var(--sp-3)" }}>
      <div className="text-label" style={{ color: "var(--fg-3)", marginBottom: "var(--sp-2)" }}>
        {label}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>{children}</div>
    </div>
  );
}

function InstallationAction({
  installation,
  connectMutation,
  disconnectMutation,
}: {
  installation: GithubAppConnectPanelInstallation;
  connectMutation: ReturnType<typeof useMutation<void, Error, number>>;
  disconnectMutation: ReturnType<typeof useMutation<void, Error, void>>;
}) {
  if (installation.status === "connectable") {
    // Disable every connectable row while any connect is in flight, not just the
    // clicked one: the server enforces one installation per team, so two racing
    // POSTs are decided by whichever write lands first (the loser 409s). If a
    // second row could fire mid-flight, the final binding would be that race's
    // winner, not the user's last click — so serialize connects here. Only the
    // row actually being connected shows the "Connecting…" label.
    const connecting = connectMutation.isPending && connectMutation.variables === installation.installationId;
    return (
      <Button
        type="button"
        size="sm"
        onClick={() => connectMutation.mutate(installation.installationId)}
        disabled={connectMutation.isPending}
      >
        {connecting ? "Connecting…" : "Connect"}
      </Button>
    );
  }

  if (installation.status === "connected-here") {
    return (
      <div className="flex items-center" style={{ gap: "var(--sp-2)", justifyContent: "flex-end" }}>
        <span className="text-label" style={{ color: "var(--fg-3)" }}>
          Connected to this team
        </span>
        {/* Neutral outline for now; unifying destructive styling with the
            clients page is deferred. */}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => disconnectMutation.mutate()}
          disabled={disconnectMutation.isPending}
        >
          {disconnectMutation.isPending ? "Disconnecting…" : "Disconnect"}
        </Button>
      </div>
    );
  }

  return (
    <span className="text-label" style={{ color: "var(--fg-3)" }}>
      Connected to {installation.connectedTeamName ?? "another team"}
    </span>
  );
}

function InstallationRow({
  installation,
  children,
}: {
  installation: GithubAppConnectPanelInstallation;
  children: ReactNode;
}) {
  const AccountIcon = installation.accountType === "Organization" ? Building2 : User;
  return (
    <div className="flex items-center" style={{ gap: "var(--sp-2)", justifyContent: "space-between" }}>
      <div className="flex items-center" style={{ gap: "var(--sp-2)", minWidth: 0 }}>
        <AccountIcon className="h-4 w-4 shrink-0" style={{ color: "var(--fg-2)" }} />
        <span className="text-body font-medium" style={{ color: "var(--fg)", overflowWrap: "anywhere" }}>
          {githubAccountPath(installation.accountLogin)}
        </span>
        <span className="text-caption" style={{ color: "var(--fg-3)" }}>
          {installation.accountType}
        </span>
        {installation.suspended && (
          <span className="text-label" style={{ color: "var(--color-warn)" }}>
            Suspended
          </span>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/**
 * Collapsed-by-default disclosure for the developer-facing connection
 * metadata: the granted permission scopes, the subscribed webhook events,
 * and the installation id. Kept off the default view (most admins only need
 * "who's connected" + Manage) but one click away for scope auditing. A plain
 * `aria-expanded` button — there's no shared collapsible primitive in this app,
 * and the controlled toggle keeps the chevron and the mounted content in
 * lockstep.
 */
function ConnectionDetails({ data }: { data: GithubAppInstallationOutput }) {
  const [open, setOpen] = useState(false);
  const permissionEntries = Object.entries(data.permissions);
  const regionId = "github-connection-details";

  return (
    <div style={{ borderTop: "var(--hairline) solid var(--border)", paddingTop: "var(--sp-3)" }}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={open ? regionId : undefined}
      >
        <ChevronRight
          aria-hidden
          className="h-3 w-3 transition-transform"
          style={{ transform: open ? "rotate(90deg)" : "none" }}
        />
        Connection details
      </Button>

      {open && (
        <div
          id={regionId}
          style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)", marginTop: "var(--sp-3)" }}
        >
          {permissionEntries.length > 0 && (
            <div>
              <div className="text-label" style={{ color: "var(--fg-3)", marginBottom: "var(--sp-1)" }}>
                Permissions granted
              </div>
              <ul
                className="text-body"
                style={{
                  listStyle: "none",
                  padding: 0,
                  margin: 0,
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "var(--sp-1)",
                  color: "var(--fg-2)",
                }}
              >
                {permissionEntries.map(([key, value]) => (
                  <li key={key} className="mono">
                    {key}: <strong style={{ color: "var(--fg)" }}>{value}</strong>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {data.events.length > 0 && (
            <div>
              <div className="text-label" style={{ color: "var(--fg-3)", marginBottom: "var(--sp-1)" }}>
                Subscribed events
              </div>
              <div className="text-body mono" style={{ color: "var(--fg-2)" }}>
                {data.events.join(", ")}
              </div>
            </div>
          )}

          <span className="text-label" style={{ color: "var(--fg-3)" }}>
            Installation #{data.installationId}
          </span>
        </div>
      )}
    </div>
  );
}

function SuspendedBanner() {
  return (
    <div
      className="flex items-start text-body"
      style={{
        gap: "var(--sp-2)",
        padding: "var(--sp-2) var(--sp-2_5)",
        background: "var(--color-warn-soft)",
        borderRadius: "var(--radius-input)",
        color: "var(--color-warn)",
      }}
    >
      <PauseCircle className="h-4 w-4 shrink-0" style={{ marginTop: "var(--sp-0_5)" }} />
      <span>
        This installation is suspended upstream. GitHub is not delivering webhooks and First Tree can't act as the App
        on this account. Unsuspend it from the GitHub side to restore service.
      </span>
    </div>
  );
}
