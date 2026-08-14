import {
  GITHUB_TASK_REPLY_REQUIRED_PERMISSIONS,
  type GithubAppInstallationOutput,
  type GithubPermissionLevel,
  githubPermissionSatisfies,
} from "@first-tree/shared";
import { Check, ChevronRight, CircleAlert, CircleCheck, Copy, ExternalLink } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { Button } from "../components/ui/button.js";
import { useCopyFeedback } from "../lib/use-copy-feedback.js";

/**
 * Human names for the GitHub permission keys an installation is likely to
 * carry. `permissions` is a free-form record on purpose (GitHub adds keys over
 * time and we don't want an `app_id` bump just to name one), so an unknown key
 * falls back to a de-underscored form rather than being dropped.
 */
const PERMISSION_LABELS: Record<string, string> = {
  actions: "Actions",
  administration: "Administration",
  checks: "Checks",
  contents: "Contents",
  discussions: "Discussions",
  issues: "Issues",
  members: "Members",
  metadata: "Metadata",
  organization_administration: "Organization administration",
  pull_requests: "Pull requests",
  workflows: "Workflows",
};

/**
 * Webhook events First Tree turns into agent activity — mirrors the `buildRule`
 * switch in the server's `github-normalize.ts`. These are the ones that can
 * produce a message, which is what you're checking when an event seems to have
 * gone nowhere.
 */
const ACTIVITY_EVENT_LABELS: Record<string, string> = {
  commit_comment: "Commit comments",
  discussion: "Discussions",
  discussion_comment: "Discussion comments",
  issue_comment: "Issue comments",
  issues: "Issues",
  pull_request: "Pull requests",
  pull_request_review: "PR reviews",
  pull_request_review_comment: "PR review comments",
};

/**
 * Events the webhook route consumes before it ever reaches `buildRule` — they
 * create, refresh, suspend/resume and delete the installation record and its
 * repository coverage (`api/webhooks/github-app.ts`, `handleInstallationLifecycle`).
 *
 * Classified apart from both lists on purpose: they produce no agent activity,
 * so they can't sit under the activity heading, but they are very much handled,
 * so grouping them with the dropped subscriptions would tell an admin their
 * normally configured installation is misconfigured.
 */
const LIFECYCLE_EVENT_LABELS: Record<string, string> = {
  installation: "Installation lifecycle",
  installation_repositories: "Repository access changes",
};

/** What the team loses while a required permission is missing. */
const PERMISSION_SHORTFALL: Record<string, string> = {
  issues: "Agents can't post replies on issues.",
  pull_requests: "Agents can't post replies on pull requests.",
};

function humanize(value: string): string {
  const spaced = value.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function permissionLabel(name: string): string {
  return PERMISSION_LABELS[name] ?? humanize(name);
}

function shortfallCopy(name: string, required: GithubPermissionLevel): string {
  return PERMISSION_SHORTFALL[name] ?? `First Tree needs ${required} access here.`;
}

type RequiredPermission = {
  name: string;
  required: GithubPermissionLevel;
  granted: GithubPermissionLevel | undefined;
  satisfied: boolean;
};

/** Collapsed-state summary: name the single gap, or count several. */
function blockedSummary(blocked: RequiredPermission[]): string {
  const [only] = blocked;
  return blocked.length === 1 && only
    ? `${permissionLabel(only.name)} access is missing`
    : `${blocked.length} required permissions are missing`;
}

function readRequiredPermissions(permissions: GithubAppInstallationOutput["permissions"]): RequiredPermission[] {
  return Object.entries(GITHUB_TASK_REPLY_REQUIRED_PERMISSIONS).map(([name, required]) => ({
    name,
    required,
    granted: permissions[name],
    satisfied: githubPermissionSatisfies(permissions[name], required),
  }));
}

/**
 * Collapsed-by-default disclosure for the connection's developer-facing
 * detail. It used to transcribe GitHub's `permissions` / `events` blobs
 * verbatim, which left the reader to diff them against a requirement they'd
 * have to already know. It now answers the question they opened it with —
 * "can this installation do the thing I'm waiting on?" — before falling back
 * to the raw grants:
 *
 *   - **Required for automatic replies** — one row per
 *     `GITHUB_TASK_REPLY_REQUIRED_PERMISSIONS` entry (the same set the server's
 *     task-reply gate reads), each marked ready or blocked. Scoped to that
 *     capability, not a verdict on the installation: other capabilities gate on
 *     their own permissions, events, and repository coverage.
 *   - **Also granted** — everything else, secondary.
 *   - **Events** — the subscriptions that produce agent activity, named in
 *     prose, with lifecycle traffic and genuinely dropped subscriptions each
 *     called out separately instead of blended together.
 *   - **Installation** — id (copyable), and the two timestamps the API already
 *     returns, which are the first thing you want when reconstructing "when
 *     did this change".
 *
 * A shortfall also marks the collapsed toggle, so the one state worth acting
 * on isn't hidden behind a closed disclosure.
 *
 * A plain `aria-expanded` button — there's no shared collapsible primitive in
 * this app, and the controlled toggle keeps the chevron and the mounted
 * content in lockstep.
 */
export function GithubConnectionDetails({
  data,
  readOnly = false,
  defaultOpen = false,
}: {
  data: GithubAppInstallationOutput;
  /** Members read the same facts but get no GitHub-side call to action. */
  readOnly?: boolean;
  /** The DEV `/preview/settings-github` gallery renders the expanded state directly. */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  // Per instance, not a module constant: the DEV gallery renders several of
  // these on one page, and a shared literal would emit duplicate ids and an
  // ambiguous `aria-controls`.
  const regionId = useId();
  const required = readRequiredPermissions(data.permissions);
  const blocked = required.filter((permission) => !permission.satisfied);
  const requiredNames = new Set(required.map((permission) => permission.name));
  const alsoGranted = Object.entries(data.permissions)
    .filter(([name]) => !requiredNames.has(name))
    .sort(([a], [b]) => permissionLabel(a).localeCompare(permissionLabel(b)));
  const activity = data.events.filter((event) => event in ACTIVITY_EVENT_LABELS);
  const lifecycle = data.events.filter((event) => event in LIFECYCLE_EVENT_LABELS);
  const ignored = data.events.filter(
    (event) => !(event in ACTIVITY_EVENT_LABELS) && !(event in LIFECYCLE_EVENT_LABELS),
  );

  return (
    <div style={{ borderTop: "var(--hairline) solid var(--border)", paddingTop: "var(--sp-3)" }}>
      <div className="flex flex-wrap items-center" style={{ gap: "var(--sp-2)" }}>
        {/* `-ml-3` cancels the button's own `px-3` so the chevron lands on this
            block's left edge instead of floating one padding step inside it. */}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="-ml-3"
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
        {/* Surface the one state worth acting on even while collapsed. */}
        {blocked.length > 0 && !open ? (
          <span className="inline-flex items-center text-label" style={{ gap: "var(--sp-1)" }}>
            <CircleAlert aria-hidden className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--state-blocked)" }} />
            <span style={{ color: "var(--state-blocked)" }}>{blockedSummary(blocked)}</span>
          </span>
        ) : null}
      </div>

      {open && (
        <div
          id={regionId}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--sp-4)",
            marginTop: "var(--sp-3)",
            // Line the blocks up under the disclosure's label (chevron + its
            // gap), so opening the section extends one column rather than
            // starting a new one further left.
            paddingLeft: "var(--sp-5)",
          }}
        >
          <DetailBlock label="Required for automatic replies">
            <div className="flex flex-col" style={{ gap: "var(--sp-1_5)" }}>
              {required.map((permission) => (
                <RequiredPermissionRow
                  key={permission.name}
                  permission={permission}
                  manageUrl={data.manageUrl}
                  readOnly={readOnly}
                />
              ))}
            </div>
          </DetailBlock>

          {alsoGranted.length > 0 && (
            <DetailBlock label="Also granted">
              <p className="text-label m-0" style={{ color: "var(--fg-3)" }}>
                {alsoGranted.map(([name, level], index) => (
                  <span key={name}>
                    {index > 0 ? " · " : ""}
                    {permissionLabel(name)} <span style={{ color: "var(--fg-4)" }}>{level}</span>
                  </span>
                ))}
              </p>
            </DetailBlock>
          )}

          <DetailBlock label="Events First Tree listens for">
            <p className="text-label m-0" style={{ color: "var(--fg-2)" }}>
              {activity.length > 0
                ? activity.map((event) => ACTIVITY_EVENT_LABELS[event]).join(" · ")
                : "None of this installation's subscriptions produce First Tree activity."}
            </p>
            {lifecycle.length > 0 && (
              // Handled, just not by the activity path — say so, or a normally
              // configured installation reads as carrying dead subscriptions.
              <p className="text-caption m-0" style={{ marginTop: "var(--sp-1)", color: "var(--fg-3)" }}>
                Kept in sync from: {lifecycle.map((event) => LIFECYCLE_EVENT_LABELS[event]).join(" · ")}
              </p>
            )}
            {ignored.length > 0 && (
              // Named rather than hidden: "you subscribed to it, we drop it" is
              // the answer when someone is hunting a webhook that changed nothing.
              <p className="text-caption m-0" style={{ marginTop: "var(--sp-1)", color: "var(--fg-4)" }}>
                Subscribed but unused: {ignored.join(", ")}
              </p>
            )}
          </DetailBlock>

          <DetailBlock label="Installation">
            <dl className="m-0 grid" style={{ gap: "var(--sp-1_5) var(--sp-4)", gridTemplateColumns: "auto 1fr" }}>
              <DetailField term="ID">
                <span className="inline-flex items-center" style={{ gap: "var(--sp-1)" }}>
                  <span className="mono">{data.installationId}</span>
                  <CopyInstallationId installationId={data.installationId} />
                </span>
              </DetailField>
              {/* "First seen", not "Connected": this is when First Tree first
                  stored the installation. The row is created by the
                  `installation.created` webhook while still unbound, and it
                  survives a disconnect/rebind — so it is not the moment this
                  team connected. Labelling it that way would put a wrong date
                  into exactly the timeline this block exists to reconstruct. */}
              <DetailField term="First seen">{formatDate(data.createdAt)}</DetailField>
              <DetailField term="Last updated">{formatDate(data.updatedAt)}</DetailField>
            </dl>
          </DetailBlock>
        </div>
      )}
    </div>
  );
}

function RequiredPermissionRow({
  permission,
  manageUrl,
  readOnly,
}: {
  permission: RequiredPermission;
  manageUrl: string;
  readOnly: boolean;
}) {
  // Blocked, not "needs you": the fix lives on GitHub's side, and a First Tree
  // admin role alone doesn't establish they can grant it there (DESIGN.md §3).
  const Glyph = permission.satisfied ? CircleCheck : CircleAlert;
  const color = permission.satisfied ? "var(--success)" : "var(--state-blocked)";
  return (
    <div className="flex flex-col sm:flex-row sm:items-center" style={{ gap: "var(--sp-2)" }}>
      <span className="inline-flex min-w-0 flex-1 items-center" style={{ gap: "var(--sp-2)" }}>
        <Glyph aria-hidden className="h-4 w-4 shrink-0" style={{ color }} />
        <span className="text-label" style={{ color: "var(--fg)" }}>
          {permissionLabel(permission.name)}
        </span>
        <span className="text-label" style={{ color: "var(--fg-3)" }}>
          {permission.granted ?? "not granted"}
        </span>
        {!permission.satisfied && (
          <span className="text-caption" style={{ color: "var(--fg-3)" }}>
            {shortfallCopy(permission.name, permission.required)}
          </span>
        )}
      </span>
      {!permission.satisfied && !readOnly && (
        <Button asChild variant="outline" size="xs" className="shrink-0">
          <a href={manageUrl} target="_blank" rel="noreferrer">
            Grant on GitHub
            <ExternalLink className="h-3 w-3" />
          </a>
        </Button>
      )}
    </div>
  );
}

/**
 * Same shape as the other copy affordances in this app (`inline-command.tsx`,
 * `invite-link-panel.tsx`): the visible label carries the state, including the
 * `failed` one `useCopyFeedback` returns in a non-secure context or when the
 * clipboard permission is denied. An icon-only button that ignores `failed`
 * looks inert exactly when the copy didn't happen.
 */
function CopyInstallationId({ installationId }: { installationId: number }) {
  const { status, copy } = useCopyFeedback();
  return (
    <Button type="button" variant="ghost" size="xs" onClick={() => void copy(String(installationId))}>
      {status === "copied" ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {status === "failed" ? "Copy failed" : status === "copied" ? "Copied" : "Copy"}
    </Button>
  );
}

function DetailBlock({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-label" style={{ color: "var(--fg-3)", marginBottom: "var(--sp-1_5)" }}>
        {label}
      </div>
      {children}
    </div>
  );
}

function DetailField({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-label" style={{ color: "var(--fg-3)" }}>
        {term}
      </dt>
      <dd className="text-label m-0" style={{ color: "var(--fg-2)" }}>
        {children}
      </dd>
    </>
  );
}

/**
 * Absolute dates, not "3 days ago": this block is read while reconstructing a
 * timeline against GitHub's own audit log, where a relative age has to be
 * converted back before it's usable. Named month over an all-numeric date so
 * the day/month order can't be misread across locales.
 */
function formatDate(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
