import type { GithubAppInstallationOutput } from "@first-tree/shared";
import { ArrowRight, Bot, Building2, ExternalLink, FolderGit2, Github, PauseCircle, User } from "lucide-react";
import { useState } from "react";
import { Button } from "../components/ui/button.js";
import { PageHeader } from "../components/ui/page-header.js";
import { Section } from "../components/ui/section.js";
import { Select } from "../components/ui/select.js";
import { SettingRow } from "../components/ui/setting-row.js";
import { GithubConnectionDetails } from "./github-connection-details.js";

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
 * Connection, automatic handling, and the Repositories hand-off are separate
 * provider-owned sections, each a `SettingRow` (glyph + name + effect on the
 * left, control right-aligned). The markup here mirrors the real page closely
 * enough to review their hierarchy without a live GitHub installation.
 */

const MOCK: GithubAppInstallationOutput = {
  installationId: 131952074,
  accountType: "Organization",
  accountLogin: "agent-team-foundation",
  accountGithubId: 987654,
  permissions: {
    issues: "write",
    members: "read",
    metadata: "read",
    actions: "write",
    contents: "write",
    pull_requests: "write",
    administration: "write",
  },
  events: ["issues", "issue_comment", "member", "pull_request", "pull_request_review", "push"],
  suspended: false,
  manageUrl: "https://github.com/organizations/agent-team-foundation/settings/installations/131952074",
  createdAt: "2026-08-03T09:12:00.000Z",
  updatedAt: "2026-08-06T16:41:00.000Z",
};

/** Same installation with a downgraded scope — the one state worth acting on. */
const MOCK_MISSING_PERMISSION: GithubAppInstallationOutput = {
  ...MOCK,
  permissions: { ...MOCK.permissions, pull_requests: "read" },
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

function AutomaticHandlingPreview() {
  const [agentUuid, setAgentUuid] = useState("dev-agent");
  const agentName = agentUuid === "release-agent" ? "Release Agent" : "Dev Assistant";

  return (
    <SettingRow
      icon={<Bot className="h-4 w-4" />}
      title="GitHub Task Agent"
      description={`${agentName} automatically handles Issue and pull request activity outside the Context Tree repository and posts final replies as the First Tree GitHub App.`}
      control={
        <div style={{ minWidth: "var(--sp-45)" }}>
          <Select
            aria-label="GitHub Task Agent"
            value={agentUuid}
            onChange={setAgentUuid}
            options={[
              { value: "dev-agent", label: "Dev Assistant", hint: "Runtime ready" },
              { value: "release-agent", label: "Release Agent", hint: "Runtime ready" },
            ]}
          />
        </div>
      }
    >
      <div className="text-caption" style={{ color: "var(--fg-4)" }}>
        Context Tree activity uses Context Reviewer. These roles must use different Agents.
      </div>
    </SettingRow>
  );
}

function RepositoriesPointerPreview() {
  return (
    <SettingRow
      icon={<FolderGit2 className="h-4 w-4" />}
      title="Team code repositories"
      description="Repository URLs and the agents that may clone them live in the Repositories tab — they apply to GitLab too, so they aren't tied to this connection."
      control={
        <Button asChild variant="outline" size="sm">
          <a href="/settings/repositories#code-repositories">
            Manage repositories
            <ArrowRight className="h-3 w-3" aria-hidden />
          </a>
        </Button>
      }
    />
  );
}

/** PageHeader + provider-owned sections — the shell every state renders inside. */
function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <PageHeader title="GitHub" subtitle="Connected GitHub App" />
      <div className="flex flex-col" style={{ gap: "var(--sp-5)", padding: "var(--sp-2) var(--sp-5) var(--sp-7)" }}>
        <Section title="Connection">{children}</Section>
        <Section
          title="Automatic handling"
          description="Choose an Agent to handle Issue and pull request activity from connected GitHub repositories."
        >
          <AutomaticHandlingPreview />
        </Section>
        <Section title="Repositories">
          <RepositoriesPointerPreview />
        </Section>
      </div>
    </div>
  );
}

function InstalledCard({
  suspended = false,
  detailsOpen = false,
  data = MOCK,
}: {
  suspended?: boolean;
  detailsOpen?: boolean;
  data?: GithubAppInstallationOutput;
}) {
  return (
    <PageShell>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
        {suspended && <SuspendedBanner />}
        <SettingRow
          icon={<Github className="h-4 w-4" />}
          title="GitHub App"
          description={
            <span className="inline-flex flex-wrap items-center" style={{ gap: "var(--sp-1_5)" }}>
              <span className="inline-flex items-center" style={{ gap: "var(--sp-1)" }}>
                <AccountIcon className="h-3 w-3 shrink-0" aria-hidden />
                Connected to github.com/{data.accountLogin}
              </span>
              <span style={{ color: "var(--fg-4)" }}>{data.accountType}</span>
            </span>
          }
          control={
            <>
              <Button type="button" variant="outline" size="sm">
                Manage connection
              </Button>
              <Button asChild variant="outline" size="sm">
                <a href={data.manageUrl} target="_blank" rel="noreferrer">
                  Manage on GitHub
                  <ExternalLink className="h-3 w-3" />
                </a>
              </Button>
            </>
          }
        >
          {/* The real component, not a copy: the gallery is only useful while it
              can't drift from what ships. */}
          <GithubConnectionDetails data={data} defaultOpen={detailsOpen} />
        </SettingRow>
      </div>
    </PageShell>
  );
}

/**
 * Not-installed CTA. `waiting` mirrors the post-click state: the install opened in a new
 * tab, the CTA is locked (a second mint would clobber the in-flight nonce
 * cookie), and this tab shows the "waiting + start over" affordance while it
 * polls for the install to land.
 */
function NotInstalledCard({ waiting = false }: { waiting?: boolean }) {
  return (
    <PageShell>
      <SettingRow
        icon={<Github className="h-4 w-4" />}
        title="GitHub App"
        description="This team isn't connected to GitHub yet. Connect a GitHub App installation to start receiving issues, pull requests, and reviews as routed messages."
        control={
          <Button type="button" size="sm" disabled={waiting}>
            Install on GitHub
            <ExternalLink className="h-3 w-3" />
          </Button>
        }
      >
        {waiting && (
          <div className="flex flex-wrap items-center" style={{ gap: "var(--sp-2_5)" }}>
            <span className="text-label" style={{ color: "var(--fg-3)" }}>
              Waiting for GitHub…
            </span>
            <Button type="button" variant="link" size="sm">
              Didn't work? Start over
            </Button>
          </div>
        )}
      </SettingRow>
    </PageShell>
  );
}

/** Loading connection state. */
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
          Every section is one row: glyph + what it is + what it currently does on the left, the control that changes it
          right-aligned. Permissions, subscribed events, and the installation id sit behind a collapsed "Connection
          details" disclosure (click to toggle). GitHub Task Agent lives in the adjacent Automatic handling section
          instead of appearing as a standalone Setup capability, and Repositories hands off to the provider-neutral
          catalog rather than dead-ending here.
        </p>
      </div>

      <Frame label="Connected — default" note="developer metadata collapsed behind 'Connection details'">
        <InstalledCard />
      </Frame>

      <Frame
        label="Connected — details expanded"
        note="required scopes checked off, other grants secondary, events named, installation facts"
      >
        <InstalledCard detailsOpen />
      </Frame>

      <Frame
        label="Connected — a required scope is missing"
        note="pull_requests downgraded to read: marked blocked, with what it costs and where to fix it"
      >
        <InstalledCard detailsOpen data={MOCK_MISSING_PERMISSION} />
      </Frame>

      <Frame
        label="Missing scope — collapsed"
        note="the shortfall still marks the closed disclosure, so it isn't hidden behind a click"
      >
        <InstalledCard data={MOCK_MISSING_PERMISSION} />
      </Frame>

      <Frame label="Suspended upstream" note="webhook delivery paused on GitHub's side — banner preserved">
        <InstalledCard suspended />
      </Frame>

      <Frame label="Not installed" note="the Install on GitHub CTA alongside provider-owned automatic handling">
        <NotInstalledCard />
      </Frame>

      <Frame
        label="Not installed — waiting"
        note="after the install opened in a new tab: CTA locked, waiting for the poll + Start over"
      >
        <NotInstalledCard waiting />
      </Frame>

      <Frame label="Loading" note="initial connection fetch with automatic handling retained below">
        <LoadingCard />
      </Frame>
    </div>
  );
}
