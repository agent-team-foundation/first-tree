import type { GithubAppInstallationOutput } from "@agent-team-foundation/first-tree-hub-shared";
import { useQuery } from "@tanstack/react-query";
import { Building2, ExternalLink, PauseCircle, User } from "lucide-react";
import { buildInstallStartUrl, getGithubAppInstallation } from "../api/github-app.js";
import { useAuth } from "../auth/auth-context.js";
import { SettingsSection } from "../components/ui/settings-section.js";

/**
 * Settings → Integrations panel for the GitHub App installation.
 *
 * Three visible states:
 *
 *   - **Loading**     — initial fetch.
 *   - **Not bound**   — 404 from the admin API. Renders an "Install on
 *                       GitHub" CTA that triggers the OAuth + install
 *                       redirect via `/auth/github/start`.
 *   - **Bound**       — shows account login + type + permissions block +
 *                       subscribed events + a "Manage on GitHub" link
 *                       that opens the right per-account-type URL.
 *
 * Suspended installations get a prominent "suspended upstream" banner —
 * webhook delivery is paused on GitHub's side and the binding is
 * effectively inactive until unsuspended.
 */
export function GithubAppInstallationPanel({ isFirst = false }: { isFirst?: boolean }) {
  const { organizationId } = useAuth();

  const installationQuery = useQuery({
    queryKey: ["github-app-installation", organizationId],
    queryFn: () => (organizationId ? getGithubAppInstallation(organizationId) : Promise.reject(new Error("no org"))),
    enabled: !!organizationId,
  });

  return (
    <SettingsSection
      title="GitHub App"
      description="One installation unlocks user sign-in, webhook ingestion, and (later) server-side write access."
      isFirst={isFirst}
    >
      {installationQuery.isLoading ? (
        <div className="text-body" style={{ color: "var(--fg-3)" }}>
          Loading…
        </div>
      ) : installationQuery.error ? (
        <div className="text-body" style={{ color: "var(--state-error)" }}>
          {installationQuery.error instanceof Error ? installationQuery.error.message : "Failed to load installation"}
        </div>
      ) : installationQuery.data == null ? (
        // `null` (404 — no install bound) and `undefined` (query disabled
        // because organizationId hasn't loaded) both render the empty
        // state; the loading branch above already caught the in-flight case.
        <NotInstalledState />
      ) : (
        <InstalledState data={installationQuery.data} />
      )}
    </SettingsSection>
  );
}

function NotInstalledState() {
  return (
    <div>
      <p className="text-body" style={{ color: "var(--fg-2)", marginBottom: "var(--sp-3)" }}>
        Install the GitHub App on your personal account or organization to start receiving issues, pull requests, and
        reviews as routed messages.
      </p>
      {/* The install flow is `<a>`-based because it's a server-initiated
       * 302 — using <Button as="a"> would require the Button component to
       * polymorphism that it doesn't expose. The styling matches the
       * default button via the shared utility classes. */}
      <a
        href={buildInstallStartUrl()}
        className="inline-flex items-center justify-center font-medium"
        style={{
          gap: "var(--sp-1)",
          padding: "var(--sp-2) var(--sp-3)",
          background: "var(--accent)",
          color: "var(--accent-fg, white)",
          borderRadius: "var(--radius-input)",
          textDecoration: "none",
        }}
      >
        Install on GitHub
        <ExternalLink className="h-3 w-3" />
      </a>
    </div>
  );
}

function InstalledState({ data }: { data: GithubAppInstallationOutput }) {
  const AccountIcon = data.accountType === "Organization" ? Building2 : User;
  const permissionEntries = Object.entries(data.permissions);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
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

      <div className="flex items-center" style={{ gap: "var(--sp-2)" }}>
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
        <span className="text-label" style={{ color: "var(--fg-3)" }}>
          Installation #{data.installationId}
        </span>
      </div>
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
        background: "var(--bg-sunken)",
        borderRadius: "var(--radius-input)",
        color: "var(--state-warning, var(--fg-3))",
      }}
    >
      <PauseCircle className="h-4 w-4 shrink-0" style={{ marginTop: "var(--sp-0_5)" }} />
      <span>
        This installation is suspended upstream. GitHub is not delivering webhooks and Hub can't act as the App on this
        account. Unsuspend it from the GitHub side to restore service.
      </span>
    </div>
  );
}
