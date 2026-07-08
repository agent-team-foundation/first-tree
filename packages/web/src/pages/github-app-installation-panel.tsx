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
export function GithubAppInstallationPanel() {
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
    return <NotConnectedSummary disabled={!organizationId} onOpenPanel={() => setPanelOpen(true)} />;
  }
  return <InstalledState data={installationQuery.data} onOpenPanel={() => setPanelOpen(true)} />;
}

/**
 * Unbound summary: the team has no GitHub connection yet, so the whole
 * surface is one prominent entry point into the connect panel.
 */
function NotConnectedSummary({ disabled, onOpenPanel }: { disabled: boolean; onOpenPanel: () => void }) {
  return (
    <div>
      <p className="text-body" style={{ color: "var(--fg-2)", marginBottom: "var(--sp-3)" }}>
        This team isn't connected to GitHub yet. Connect a GitHub App installation to start receiving issues, pull
        requests, and reviews as routed messages.
      </p>
      <button
        type="button"
        onClick={onOpenPanel}
        disabled={disabled}
        className="inline-flex items-center justify-center font-medium"
        style={{
          gap: "var(--sp-1)",
          padding: "var(--sp-2) var(--sp-3)",
          background: "var(--primary)",
          color: "var(--primary-on)",
          border: "none",
          borderRadius: "var(--radius-input)",
          cursor: disabled ? "default" : "pointer",
          opacity: disabled ? 0.6 : 1,
        }}
      >
        Connect GitHub
      </button>
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

function InstalledState({ data, onOpenPanel }: { data: GithubAppInstallationOutput; onOpenPanel: () => void }) {
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
          <span
            className="text-label"
            style={{
              padding: "var(--sp-0_5) var(--sp-1_5)",
              background: "var(--bg-sunken)",
              borderRadius: "var(--radius-input)",
              color: "var(--fg-3)",
            }}
          >
            {data.accountType}
          </span>
        </div>
        {/* Expandable details sit directly under the connected account they
            describe, not below the action buttons. */}
        <div style={{ marginTop: "var(--sp-3)" }}>
          <ConnectionDetails data={data} />
        </div>
      </div>

      <div className="flex items-center" style={{ gap: "var(--sp-2)", flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={onOpenPanel}
          className="inline-flex items-center text-body"
          style={{
            gap: "var(--sp-1)",
            padding: "var(--sp-1_5) var(--sp-2_5)",
            border: "var(--hairline) solid var(--border)",
            borderRadius: "var(--radius-input)",
            background: "transparent",
            color: "var(--fg)",
            cursor: "pointer",
          }}
        >
          Manage connection
        </button>
        <a
          href={data.manageUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center text-body"
          style={{
            gap: "var(--sp-1)",
            padding: "var(--sp-1_5) var(--sp-2_5)",
            border: "var(--hairline) solid var(--border)",
            borderRadius: "var(--radius-input)",
            color: "var(--fg)",
            textDecoration: "none",
          }}
        >
          Manage on GitHub
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
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
  const connectedHere = installations.filter((i) => i.status === "connected-here");
  const connectedElsewhere = installations.filter((i) => i.status === "connected-elsewhere");

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
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center text-label"
          style={{
            gap: "var(--sp-1)",
            color: "var(--fg-3)",
            background: "transparent",
            border: "none",
            padding: 0,
            cursor: "pointer",
          }}
        >
          <ArrowLeft aria-hidden className="h-3 w-3" />
          Back
        </button>
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
            <button
              type="button"
              onClick={handleInstall}
              disabled={installDisabled}
              className="inline-flex items-center text-body"
              style={{
                gap: "var(--sp-1)",
                padding: "var(--sp-1) var(--sp-2)",
                border: "var(--hairline) solid var(--border)",
                borderRadius: "var(--radius-input)",
                background: "transparent",
                color: "var(--fg)",
                cursor: installDisabled ? "default" : "pointer",
                opacity: installDisabled ? 0.6 : 1,
              }}
            >
              {installUrlMutation.isPending ? "Opening GitHub…" : "Reinstall"}
            </button>
            <a
              href={bound.manageUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center text-body"
              style={{
                gap: "var(--sp-1)",
                padding: "var(--sp-1) var(--sp-2)",
                border: "var(--hairline) solid var(--border)",
                borderRadius: "var(--radius-input)",
                color: "var(--fg)",
                textDecoration: "none",
              }}
            >
              Manage on GitHub
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        ) : (
          // Button (not anchor) because the install URL is minted on click,
          // then a synchronously-opened new tab is navigated to it — keeps the
          // state JWT + nonce cookie fresh and the popup unblocked.
          <button
            type="button"
            onClick={handleInstall}
            disabled={installDisabled}
            className="inline-flex items-center justify-center font-medium"
            style={{
              gap: "var(--sp-1)",
              padding: "var(--sp-2) var(--sp-3)",
              background: "var(--primary)",
              color: "var(--primary-on)",
              border: "none",
              borderRadius: "var(--radius-input)",
              cursor: installDisabled ? "default" : "pointer",
              opacity: installDisabled ? 0.6 : 1,
            }}
          >
            {installUrlMutation.isPending ? "Opening GitHub…" : "Install on GitHub"}
            <ExternalLink className="h-3 w-3" />
          </button>
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
            <button
              type="button"
              onClick={handleStartOver}
              className="text-label underline underline-offset-2"
              style={{
                background: "transparent",
                border: "none",
                padding: 0,
                color: "var(--fg-3)",
                cursor: "pointer",
              }}
            >
              Didn't work? Start over
            </button>
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

      {connectedHere.length > 0 && (
        <InstallationGroup label="Connected to this team">
          {connectedHere.map((installation) => (
            <InstallationRow key={installation.installationId} installation={installation}>
              <button
                type="button"
                onClick={() => disconnectMutation.mutate()}
                disabled={disconnectMutation.isPending}
                className="text-body"
                style={{
                  padding: "var(--sp-1) var(--sp-2)",
                  border: "var(--hairline) solid var(--border)",
                  borderRadius: "var(--radius-input)",
                  background: "transparent",
                  color: "var(--state-error)",
                  cursor: disconnectMutation.isPending ? "default" : "pointer",
                }}
              >
                {disconnectMutation.isPending ? "Disconnecting…" : "Disconnect"}
              </button>
            </InstallationRow>
          ))}
        </InstallationGroup>
      )}

      {connectable.length > 0 && (
        <InstallationGroup label="Available to connect">
          {connectable.map((installation) => (
            <InstallationRow key={installation.installationId} installation={installation}>
              <button
                type="button"
                onClick={() => connectMutation.mutate(installation.installationId)}
                disabled={connectMutation.isPending}
                className="text-body font-medium"
                style={{
                  padding: "var(--sp-1) var(--sp-2)",
                  border: "none",
                  borderRadius: "var(--radius-input)",
                  background: "var(--primary)",
                  color: "var(--primary-on)",
                  cursor: connectMutation.isPending ? "default" : "pointer",
                  opacity: connectMutation.isPending ? 0.6 : 1,
                }}
              >
                {connectMutation.isPending && connectMutation.variables === installation.installationId
                  ? "Connecting…"
                  : "Connect"}
              </button>
            </InstallationRow>
          ))}
        </InstallationGroup>
      )}

      {connectedElsewhere.length > 0 && (
        <InstallationGroup label="Connected to other teams">
          {connectedElsewhere.map((installation) => (
            <InstallationRow key={installation.installationId} installation={installation}>
              <span className="text-label" style={{ color: "var(--fg-3)" }}>
                Connected to {installation.connectedTeamName ?? "another team"}
              </span>
            </InstallationRow>
          ))}
        </InstallationGroup>
      )}

      {!panelQuery.isLoading && installations.length === 0 && (
        <p className="text-body" style={{ color: "var(--fg-3)", margin: 0 }}>
          No installations are linked to your GitHub account yet. Install the App above, or ask the teammate who
          installed it to connect it from their panel.
        </p>
      )}
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
        <span
          className="text-label"
          style={{
            padding: "var(--sp-0_5) var(--sp-1_5)",
            background: "var(--bg-sunken)",
            borderRadius: "var(--radius-input)",
            color: "var(--fg-3)",
          }}
        >
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
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={open ? regionId : undefined}
        className="inline-flex items-center text-label"
        style={{
          gap: "var(--sp-1)",
          color: "var(--fg-3)",
          background: "transparent",
          border: "none",
          padding: 0,
          cursor: "pointer",
        }}
      >
        <ChevronRight
          aria-hidden
          className="h-3 w-3 transition-transform"
          style={{ transform: open ? "rotate(90deg)" : "none" }}
        />
        Connection details
      </button>

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
