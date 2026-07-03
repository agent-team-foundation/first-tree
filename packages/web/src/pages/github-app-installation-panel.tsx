import type { GithubAppInstallationOutput } from "@first-tree/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Building2, ChevronRight, ExternalLink, PauseCircle, User } from "lucide-react";
import { useEffect, useState } from "react";
import { ApiError } from "../api/client.js";
import { getGithubAppInstallation, getGithubAppInstallUrl } from "../api/github-app.js";
import { useAuth } from "../auth/auth-context.js";

/**
 * Per-tab marker set when the admin kicks off an install. It locks the CTA (a
 * second mint would overwrite the first attempt's `oauth_state_nonce` cookie and
 * break its callback) and gates the "waiting for GitHub" affordance. Cleared once
 * an install is observed. Mirrors the connect-code / Context-build entries, which
 * use the same open-popup-in-a-new-tab-then-poll flow.
 */
const INSTALL_ATTEMPT_KEY = "settings:github:install-attempt";

/**
 * Settings → GitHub panel for the GitHub App installation. The page header
 * (`settings/github.tsx`) already titles the surface "GitHub", so this panel
 * stays untitled — a single hairline rule under the header opens it.
 *
 * Three visible states:
 *
 *   - **Loading**     — initial fetch.
 *   - **Not bound**   — 404 from the admin API. Renders an "Install on
 *                       GitHub" CTA that opens GitHub's install dialog in a
 *                       new tab and polls until the install lands, then flips
 *                       this tab to the bound state on its own.
 *   - **Bound**       — account login + type and a "Manage on GitHub" link.
 *                       The granted permissions, subscribed events, and
 *                       installation id are tucked behind a collapsed
 *                       "Connection details" disclosure — present for the
 *                       admin who wants to audit scope, out of the way by
 *                       default.
 *
 * Suspended installations get a prominent "suspended upstream" banner —
 * webhook delivery is paused on GitHub's side and the binding is
 * effectively inactive until unsuspended.
 */
export function GithubAppInstallationPanel() {
  const { organizationId } = useAuth();

  const installationQuery = useQuery({
    queryKey: ["github-app-installation", organizationId],
    queryFn: () => (organizationId ? getGithubAppInstallation(organizationId) : Promise.reject(new Error("no org"))),
    enabled: !!organizationId,
    // The install opens in a new tab and self-closes on GitHub's callback; this
    // tab keeps polling until the installation row appears, then renders the
    // bound state on its own (no manual refresh). Stops once installed.
    refetchInterval: (query) => (query.state.data ? false : 4000),
  });

  // Once the poll flips this tab to the bound state, drop the per-tab install
  // marker so a later uninstall/reinstall starts from a clean CTA.
  useEffect(() => {
    if (installationQuery.data && typeof window !== "undefined") {
      window.sessionStorage.removeItem(INSTALL_ATTEMPT_KEY);
    }
  }, [installationQuery.data]);

  // Only the bound card draws a top hairline (it anchors "Connected as"); the
  // loading / error / not-installed states sit flush under the page header so
  // the rule never floats above an unheadinged CTA or spinner.
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
  // `null` (404 — no install bound) and `undefined` (query disabled because
  // organizationId hasn't loaded) both render the empty state; the loading
  // branch above already caught the in-flight case.
  if (installationQuery.data == null) {
    return <NotInstalledState organizationId={organizationId} />;
  }
  return <InstalledState data={installationQuery.data} />;
}

function NotInstalledState({ organizationId }: { organizationId: string | null }) {
  // Reads the INSTALL_ATTEMPT_KEY marker (see its definition above) to lock the
  // CTA and gate the "waiting for GitHub" affordance; the parent's poll flips
  // this tab to the bound state once the install lands.
  const [attempted, setAttempted] = useState(
    () => typeof window !== "undefined" && !!window.sessionStorage.getItem(INSTALL_ATTEMPT_KEY),
  );

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
    // keeps polling and flips to the bound state on its own. The nonce cookie is
    // set on this tab's XHR but shared across tabs, so it rides along to GitHub's
    // callback in the new tab.
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

  const slugMissing = installUrlMutation.error instanceof ApiError && installUrlMutation.error.status === 503;
  const isPending = installUrlMutation.isPending;
  const disabled = !organizationId || isPending || attempted;

  return (
    <div>
      <p className="text-body" style={{ color: "var(--fg-2)", marginBottom: "var(--sp-3)" }}>
        Install the GitHub App on your personal account or organization to start receiving issues, pull requests, and
        reviews as routed messages.
      </p>
      {slugMissing ? (
        <p className="text-body" style={{ color: "var(--state-error)" }}>
          The GitHub App slug isn't configured on this First Tree deployment. Ask your operator to set{" "}
          <code className="mono">FIRST_TREE_GITHUB_APP_SLUG</code>.
        </p>
      ) : (
        <>
          {/* Button (not anchor) because the install URL is minted on click,
              then a synchronously-opened new tab is navigated to it — keeps the
              state JWT + nonce cookie fresh and the popup unblocked. */}
          <button
            type="button"
            onClick={handleInstall}
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
            {isPending ? "Opening GitHub…" : "Install on GitHub"}
            <ExternalLink className="h-3 w-3" />
          </button>
          {installUrlMutation.error && !slugMissing && (
            <p className="text-body" style={{ color: "var(--state-error)", marginTop: "var(--sp-2)" }}>
              {installUrlMutation.error instanceof Error
                ? installUrlMutation.error.message
                : "Failed to build the install URL"}
            </p>
          )}
          {/* After the tab opens, this tab waits for the poll to detect the
              install. If the GitHub tab didn't work, "Start over" re-mints (the
              only safe retry — see handleStartOver). */}
          {attempted && !isPending && (
            <div
              className="flex items-center"
              style={{ gap: "var(--sp-2_5)", marginTop: "var(--sp-3)", flexWrap: "wrap" }}
            >
              <span className="text-label" style={{ color: "var(--fg-3)" }}>
                Waiting for GitHub…
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
        </>
      )}
    </div>
  );
}

function InstalledState({ data }: { data: GithubAppInstallationOutput }) {
  const AccountIcon = data.accountType === "Organization" ? Building2 : User;
  return (
    <div
      style={{
        borderTop: "var(--hairline) solid var(--border)",
        paddingTop: "var(--sp-4)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--sp-4)",
      }}
    >
      {data.suspended && <SuspendedBanner />}

      <div>
        <div className="text-label" style={{ color: "var(--fg-3)", marginBottom: "var(--sp-1)" }}>
          Connected as
        </div>
        <div className="flex items-center" style={{ gap: "var(--sp-2)" }}>
          <AccountIcon className="h-4 w-4" style={{ color: "var(--fg-2)" }} />
          <span className="text-body font-medium" style={{ color: "var(--fg)" }}>
            {data.accountLogin}
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
      </div>

      <div>
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

      <ConnectionDetails data={data} />
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
