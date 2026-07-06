import { Building2, ChevronRight, ExternalLink, PauseCircle, User } from "lucide-react";
import { useState } from "react";
import { PageHeader } from "../components/ui/page-header.js";

/**
 * DEV-only visual review for Settings → GitHub (the connected GitHub App
 * card). No backend / no auth — same gating as the other `/preview/*`
 * routes (DEV-only in `app.tsx`).
 *
 * Mirrors the shipped layout of `github-app-installation-panel.tsx` so the
 * states can be eyeballed without a live install:
 *
 *   - **Connected (collapsed)** — the default: who's connected + Manage on
 *     GitHub. Permissions / events / installation id sit behind a closed
 *     "Connection details" disclosure.
 *   - **Connected (expanded)**  — the same card with the disclosure open.
 *   - **Suspended**             — the suspended-upstream banner above the card.
 *   - **Not installed**         — the "Install on GitHub" CTA.
 *   - **Loading**               — the initial fetch state.
 *
 * Only the bound card draws a top hairline; the not-installed / loading states
 * sit flush under the page header (matching the real panel). The markup here
 * is a faithful copy of the real panel's; keep them in sync.
 */

const MOCK = {
  accountLogin: "agent-team-foundation",
  accountType: "Organization" as const,
  permissions: {
    issues: "read",
    members: "read",
    metadata: "read",
    actions: "write",
    contents: "write",
    pull_requests: "read",
    administration: "write",
  } as Record<string, string>,
  events: ["issues", "issue_comment", "member", "pull_request", "pull_request_review", "push"],
  manageUrl: "https://github.com/organizations/agent-team-foundation/settings/installations/131952074",
  installationId: 131952074,
};

const AccountIcon = MOCK.accountType === "Organization" ? Building2 : User;

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

function ConnectionDetails({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const permissionEntries = Object.entries(MOCK.permissions);
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
          {MOCK.events.length > 0 && (
            <div>
              <div className="text-label" style={{ color: "var(--fg-3)", marginBottom: "var(--sp-1)" }}>
                Subscribed events
              </div>
              <div className="text-body mono" style={{ color: "var(--fg-2)" }}>
                {MOCK.events.join(", ")}
              </div>
            </div>
          )}
          <span className="text-label" style={{ color: "var(--fg-3)" }}>
            Installation #{MOCK.installationId}
          </span>
        </div>
      )}
    </div>
  );
}

/** PageHeader + content padding — the shell every state renders inside. */
function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <PageHeader title="GitHub" subtitle="Connected GitHub App" />
      <div style={{ padding: "var(--sp-2) var(--sp-5) var(--sp-7)" }}>{children}</div>
    </div>
  );
}

function InstalledCard({ suspended = false, detailsOpen = false }: { suspended?: boolean; detailsOpen?: boolean }) {
  return (
    <PageShell>
      <div
        style={{
          borderTop: "var(--hairline) solid var(--border)",
          paddingTop: "var(--sp-4)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--sp-4)",
        }}
      >
        {suspended && <SuspendedBanner />}
        <div>
          <div className="text-label" style={{ color: "var(--fg-3)", marginBottom: "var(--sp-1)" }}>
            Connected as
          </div>
          <div className="flex items-center" style={{ gap: "var(--sp-2)" }}>
            <AccountIcon className="h-4 w-4" style={{ color: "var(--fg-2)" }} />
            <span className="text-body font-medium" style={{ color: "var(--fg)" }}>
              {MOCK.accountLogin}
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
              {MOCK.accountType}
            </span>
          </div>
        </div>
        <div>
          <a
            href={MOCK.manageUrl}
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
        <ConnectionDetails defaultOpen={detailsOpen} />
      </div>
    </PageShell>
  );
}

/**
 * Not-installed CTA — flush under the header, no hairline (matches the real
 * panel). `waiting` mirrors the post-click state: the install opened in a new
 * tab, the CTA is locked (a second mint would clobber the in-flight nonce
 * cookie), and this tab shows the "waiting + start over" affordance while it
 * polls for the install to land.
 */
function NotInstalledCard({ waiting = false }: { waiting?: boolean }) {
  return (
    <PageShell>
      <div>
        <p className="text-body" style={{ color: "var(--fg-2)", marginBottom: "var(--sp-3)" }}>
          Install the GitHub App on your personal account or organization to start receiving issues, pull requests, and
          reviews as routed messages.
        </p>
        <button
          type="button"
          disabled={waiting}
          className="inline-flex items-center justify-center font-medium"
          style={{
            gap: "var(--sp-1)",
            padding: "var(--sp-2) var(--sp-3)",
            background: "var(--primary)",
            color: "var(--primary-on)",
            border: "none",
            borderRadius: "var(--radius-input)",
            cursor: waiting ? "default" : "pointer",
            opacity: waiting ? 0.6 : 1,
          }}
        >
          Install on GitHub
          <ExternalLink className="h-3 w-3" />
        </button>
        {waiting && (
          <div
            className="flex items-center"
            style={{ gap: "var(--sp-2_5)", marginTop: "var(--sp-3)", flexWrap: "wrap" }}
          >
            <span className="text-label" style={{ color: "var(--fg-3)" }}>
              Waiting for GitHub…
            </span>
            <button
              type="button"
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
    </PageShell>
  );
}

/** Loading — flush under the header, no hairline. */
function LoadingCard() {
  return (
    <PageShell>
      <div className="text-body" style={{ color: "var(--fg-3)" }}>
        Loading…
      </div>
    </PageShell>
  );
}

function Frame({ label, note, children }: { label: string; note: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
      <div>
        <div className="text-caption font-semibold" style={{ color: "var(--fg)" }}>
          {label}
        </div>
        <div className="text-caption" style={{ color: "var(--fg-4)" }}>
          {note}
        </div>
      </div>
      <div
        style={{
          width: 880,
          maxWidth: "100%",
          background: "var(--bg)",
          border: "var(--hairline) solid var(--border)",
          borderRadius: "var(--radius-panel)",
          overflow: "hidden",
        }}
      >
        {children}
      </div>
    </div>
  );
}

export function SettingsGithubPreviewPage() {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--bg-sunken)",
        padding: "var(--sp-6)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--sp-8)",
      }}
    >
      <div>
        <h1 className="text-title" style={{ color: "var(--fg)" }}>
          Settings → GitHub — shipped layout
        </h1>
        <p className="text-body" style={{ color: "var(--fg-3)" }}>
          Lean default: who's connected + Manage on GitHub. Permissions, subscribed events, and the installation id sit
          behind a collapsed "Connection details" disclosure (click to toggle). Only the bound card carries a top
          hairline; not-installed and loading sit flush under the header.
        </p>
      </div>

      <Frame label="Connected — default" note="developer metadata collapsed behind 'Connection details'">
        <InstalledCard />
      </Frame>

      <Frame label="Connected — details expanded" note="the disclosure open: scopes, events, installation id">
        <InstalledCard detailsOpen />
      </Frame>

      <Frame label="Suspended upstream" note="webhook delivery paused on GitHub's side — banner preserved">
        <InstalledCard suspended />
      </Frame>

      <Frame label="Not installed" note="the Install on GitHub CTA — flush under the header, no orphaned rule">
        <NotInstalledCard />
      </Frame>

      <Frame
        label="Not installed — waiting"
        note="after the install opened in a new tab: CTA locked, waiting for the poll + Start over"
      >
        <NotInstalledCard waiting />
      </Frame>

      <Frame label="Loading" note="initial fetch — flush under the header">
        <LoadingCard />
      </Frame>
    </div>
  );
}
