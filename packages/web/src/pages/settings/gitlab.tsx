import type {
  GitlabConnectionSecretResponse,
  GitlabConnectionSummary,
  GitlabIdentityLinkSummary,
} from "@first-tree/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, ExternalLink } from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
import { ApiError } from "../../api/client.js";
import {
  createGitlabConnection,
  createGitlabIdentityLink,
  deleteGitlabConnection,
  gitlabConnectionsQueryKey,
  listGitlabConnections,
  listGitlabIdentityLinks,
  reconfirmGitlabIdentityLink,
  regenerateGitlabBearer,
  removeGitlabIdentityLink,
  replaceGitlabConnection,
} from "../../api/gitlab-connections.js";
import { listMembers, type MemberListItem } from "../../api/members.js";
import { useAuth } from "../../auth/auth-context.js";
import { Button } from "../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.js";
import { Input } from "../../components/ui/input.js";
import { Label } from "../../components/ui/label.js";
import { Section } from "../../components/ui/section.js";
import { useToast } from "../../components/ui/toast.js";
import {
  GITLAB_CONNECTION_READINESS,
  type GitlabConnectionReadiness,
  gitlabConnectionPollingInterval,
  gitlabConnectionReadiness,
} from "../../lib/gitlab-connection-readiness.js";
import { useCopyFeedback } from "../../lib/use-copy-feedback.js";

const identityKey = (organizationId: string | null) => ["gitlab-identity-links", organizationId] as const;

type ConnectionDialog = "create" | "replace" | null;
type ConfirmAction = "regenerate" | "delete" | null;
type OneTimeSecret = GitlabConnectionSecretResponse;

export function SettingsGitlabPage() {
  const { role, organizationId } = useAuth();
  return (
    <OrganizationScopedGitlabPage
      key={organizationId ?? "no-organization"}
      role={role}
      organizationId={organizationId}
    />
  );
}

/**
 * The key on this component is a security boundary: Team switching unmounts
 * every one-time secret, confirmation, form error, and in-flight mutation
 * observer owned by the previous organization.
 */
function OrganizationScopedGitlabPage(props: { role: string | null; organizationId: string | null }) {
  const { role, organizationId } = props;
  const isAdmin = role === "admin";
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const [connectionDialog, setConnectionDialog] = useState<ConnectionDialog>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const [oneTimeSecret, setOneTimeSecret] = useState<OneTimeSecret | null>(null);
  const [secretActionBusy, setSecretActionBusy] = useState(false);
  const [secretActionError, setSecretActionError] = useState<unknown>(null);

  const connections = useQuery({
    queryKey: gitlabConnectionsQueryKey(organizationId),
    queryFn: listGitlabConnections,
    enabled: !!organizationId,
    refetchInterval: (query) =>
      gitlabConnectionPollingInterval({
        hasOneTimeSecret: oneTimeSecret !== null,
        connectionCount: query.state.data?.length ?? 0,
      }),
  });
  const connection = connections.data?.[0] ?? null;
  const oneTimeConnection =
    oneTimeSecret &&
    connection?.id === oneTimeSecret.connection.id &&
    isNewerConnection(connection, oneTimeSecret.connection)
      ? connection
      : (oneTimeSecret?.connection ?? null);
  const identities = useQuery({
    queryKey: identityKey(organizationId),
    queryFn: listGitlabIdentityLinks,
    enabled: isAdmin && !!organizationId,
  });
  const members = useQuery({
    queryKey: ["members", organizationId],
    queryFn: listMembers,
    enabled: isAdmin && !!organizationId,
  });
  const refresh = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: gitlabConnectionsQueryKey(organizationId) }),
      queryClient.invalidateQueries({ queryKey: identityKey(organizationId) }),
    ]);
  };

  const runRegenerate = async (): Promise<void> => {
    if (!connection) return;
    setSecretActionBusy(true);
    setSecretActionError(null);
    try {
      const result = await regenerateGitlabBearer(connection.id);
      setConfirmAction(null);
      setOneTimeSecret(result);
      await refresh();
    } catch (error) {
      setSecretActionError(error);
    } finally {
      setSecretActionBusy(false);
    }
  };
  const remove = useMutation({
    mutationFn: () => {
      if (!connection) throw new Error("GitLab connection is missing");
      return deleteGitlabConnection(connection.id);
    },
    onSuccess: async () => {
      setConfirmAction(null);
      await refresh();
      addToast({ title: "GitLab connection deleted", description: "The old webhook URL no longer authenticates." });
    },
  });
  if (role === null || connections.isPending) return <PageStatus>Loading GitLab integration…</PageStatus>;
  if (connections.error) return <PageStatus error>{errorMessage(connections.error)}</PageStatus>;

  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-5)", padding: "var(--sp-2) var(--sp-5) var(--sp-7)" }}>
      <Section
        title="Connection"
        description="Inbound-only GitLab Self-Managed webhooks. A System Hook provides full-instance merge request routing; First Tree never calls your GitLab server."
        action={
          isAdmin && !connection ? (
            <Button size="sm" onClick={() => setConnectionDialog("create")}>
              Connect GitLab
            </Button>
          ) : undefined
        }
      >
        {connection ? (
          <ConnectionSummary
            connection={connection}
            isAdmin={isAdmin}
            onRegenerate={() => setConfirmAction("regenerate")}
            onReplace={() => setConnectionDialog("replace")}
            onDelete={() => setConfirmAction("delete")}
          />
        ) : (
          <EmptyRow>No GitLab connection. An administrator can create the Team's single connection.</EmptyRow>
        )}
      </Section>

      {connection ? (
        isAdmin ? (
          <Section
            title="GitLab account bindings"
            description="Bind exact GitLab usernames to Team members. System Hook merge request reviewers, assignees, and description mentions route to the current delegate."
          >
            <IdentityPanel
              connection={connection}
              links={identities.data ?? []}
              members={members.data ?? []}
              loading={identities.isPending || members.isPending}
              onChanged={refresh}
            />
          </Section>
        ) : null
      ) : null}

      <ConnectionEditorDialog
        mode={connectionDialog}
        current={connection}
        onClose={() => setConnectionDialog(null)}
        onSecret={(result) => {
          setConnectionDialog(null);
          setOneTimeSecret(result);
          void refresh();
        }}
      />
      <OneTimeSecretDialog
        secret={oneTimeSecret}
        connection={oneTimeConnection}
        onClose={() => setOneTimeSecret(null)}
      />
      <ConfirmationDialog
        action={confirmAction}
        pending={secretActionBusy || remove.isPending}
        error={secretActionError ?? remove.error}
        onClose={() => {
          setSecretActionError(null);
          setConfirmAction(null);
        }}
        onConfirm={() => {
          if (confirmAction === "regenerate") void runRegenerate();
          if (confirmAction === "delete") remove.mutate();
        }}
      />
    </div>
  );
}

function ConnectionSummary(props: {
  connection: GitlabConnectionSummary;
  isAdmin: boolean;
  onRegenerate: () => void;
  onReplace: () => void;
  onDelete: () => void;
}) {
  const { connection } = props;
  const readiness = gitlabConnectionReadiness(connection);
  const status = CONNECTION_STATUS[readiness];
  return (
    <div className="space-y-3 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="m-0 text-body font-medium">{connection.displayName}</p>
          <a
            className="text-label text-muted-foreground hover:underline"
            href={connection.instanceOrigin}
            target="_blank"
            rel="noreferrer"
          >
            {connection.instanceOrigin} <ExternalLink className="inline h-3 w-3" aria-hidden />
          </a>
        </div>
        <span
          className="text-label"
          style={{
            color:
              readiness === GITLAB_CONNECTION_READINESS.routingVerified
                ? "var(--color-success)"
                : readiness === GITLAB_CONNECTION_READINESS.needsAttention
                  ? "var(--color-destructive)"
                  : "var(--fg-3)",
          }}
          data-testid="gitlab-connection-status"
          aria-live="polite"
        >
          {status}
        </span>
      </div>
      {props.isAdmin && readiness !== GITLAB_CONNECTION_READINESS.routingVerified ? (
        <SystemHookRecovery connection={connection} readiness={readiness} />
      ) : null}
      <ConnectionDetails connection={connection} />
      {props.isAdmin ? (
        <div className="flex flex-wrap gap-2 pt-1">
          <Button size="sm" variant="outline" onClick={props.onRegenerate}>
            Regenerate URL
          </Button>
          <Button size="sm" variant="outline" onClick={props.onReplace}>
            Change connection
          </Button>
          <Button size="sm" variant="destructive" onClick={props.onDelete}>
            Delete
          </Button>
        </div>
      ) : null}
      <p className="m-0 text-caption text-muted-foreground">
        Regenerating invalidates the old URL immediately. Change or delete clears old entity follows and identity
        routing; update the GitLab System Hook manually.
      </p>
    </div>
  );
}

const CONNECTION_STATUS: Record<GitlabConnectionReadiness, string> = {
  [GITLAB_CONNECTION_READINESS.waiting]: "Waiting for webhook",
  [GITLAB_CONNECTION_READINESS.transportReceived]: "Webhook received · waiting for MR event",
  [GITLAB_CONNECTION_READINESS.routingVerified]: "MR routing verified",
  [GITLAB_CONNECTION_READINESS.needsAttention]: "Webhook needs attention",
};

function SystemHookRecovery(props: { connection: GitlabConnectionSummary; readiness: GitlabConnectionReadiness }) {
  const received = props.readiness === GITLAB_CONNECTION_READINESS.transportReceived;
  const needsAttention = props.readiness === GITLAB_CONNECTION_READINESS.needsAttention;
  return (
    <div className="space-y-2 border-t border-border pt-3" data-testid="gitlab-system-hook-recovery">
      <p className="m-0 text-body font-medium">
        {needsAttention
          ? "Resolve the processing issue"
          : received
            ? "Finish MR verification"
            : "Finish System Hook setup"}
      </p>
      <p className="m-0 text-label text-muted-foreground">
        {needsAttention
          ? "The latest webhook was not fully processed. Confirm this is a System Hook using GitLab's default payload, then resend a real merge request event."
          : received
            ? "GitLab reached First Tree. Confirm Merge request events is enabled, then create or update a merge request."
            : "Paste the one-time First Tree URL into a GitLab System Hook. Keep the default payload and SSL verification enabled."}
      </p>
      <p className="m-0 text-label text-muted-foreground">
        Enable <strong>Push events</strong> for delivery-health evidence and <strong>Merge request events</strong> for
        full-instance MR routing.
      </p>
      <p className="m-0 text-label text-muted-foreground">System Hooks do not deliver Issue or Note events.</p>
      <div className="flex flex-wrap items-center gap-3">
        <Button asChild size="sm" variant="outline">
          <a href={gitlabAdminHooksUrl(props.connection.instanceOrigin)} target="_blank" rel="noreferrer">
            Open GitLab System hooks
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          </a>
        </Button>
        <span className="text-caption text-muted-foreground">
          The URL stays hidden after setup. Regenerate only if it was not saved.
        </span>
      </div>
    </div>
  );
}

function ConnectionDetails({ connection }: { connection: GitlabConnectionSummary }) {
  return (
    <details className="text-label text-muted-foreground">
      <summary className="w-fit cursor-pointer select-none text-foreground">Connection details</summary>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <span>
          Last valid inbound:{" "}
          {connection.health.lastValidInboundAt ? formatDate(connection.health.lastValidInboundAt) : "Never"}
        </span>
        <span>
          Last System Hook MR event:{" "}
          {connection.health.lastSystemHookMergeRequestInboundAt
            ? formatDate(connection.health.lastSystemHookMergeRequestInboundAt)
            : "Never"}
        </span>
        <span>
          Stable delivery ID:{" "}
          {connection.stableDeliveryObserved ? "Observed" : "Not observed — repeats may duplicate or be lost"}
        </span>
        <span>GitLab version: {connection.reviewerCapability.lastObservedVersion ?? "Not observed"}</span>
        <span>
          Reviewer compatibility:{" "}
          {connection.reviewerCapability.mode === "reviewers"
            ? "Modern"
            : connection.reviewerCapability.mode === "assignee"
              ? "Legacy fallback"
              : "Auto-detecting"}
        </span>
        {connection.health.lastProcessingFailureAt ? (
          <span className="text-destructive sm:col-span-2">
            Latest processing issue: {connection.health.lastProcessingFailureCode ?? "unknown"}
          </span>
        ) : null}
      </div>
    </details>
  );
}

function IdentityPanel(props: {
  connection: GitlabConnectionSummary;
  links: GitlabIdentityLinkSummary[];
  members: MemberListItem[];
  loading: boolean;
  onChanged: () => Promise<void>;
}) {
  const { addToast } = useToast();
  const [membershipId, setMembershipId] = useState("");
  const [username, setUsername] = useState("");
  const [removeConfirmation, setRemoveConfirmation] = useState<GitlabIdentityLinkSummary | null>(null);
  const queryClient = useQueryClient();
  const create = useMutation({
    mutationFn: () => createGitlabIdentityLink({ connectionId: props.connection.id, membershipId, username }),
    onSuccess: async () => {
      setUsername("");
      setMembershipId("");
      await props.onChanged();
      addToast({ title: "GitLab account bound" });
    },
  });
  const transition = useMutation({
    mutationFn: async ({ id, action }: { id: string; action: "remove" | "reconfirm" }) => {
      if (action === "remove") await removeGitlabIdentityLink(id);
      else await reconfirmGitlabIdentityLink(id);
    },
    onSuccess: async () => {
      await props.onChanged();
      await queryClient.invalidateQueries({ queryKey: ["gitlab-connections"] });
    },
  });
  const memberNames = useMemo(
    () => new Map(props.members.map((member) => [member.id, member.displayName])),
    [props.members],
  );
  const visibleLinks = useMemo(() => {
    return props.links.filter((link) => link.connectionId === props.connection.id);
  }, [props.connection.id, props.links]);
  if (props.loading) return <EmptyRow>Loading account bindings…</EmptyRow>;
  return (
    <div className="space-y-4 py-4">
      <form
        className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <label className="space-y-1 text-label" htmlFor="gitlab-identity-member">
          <span>Team member</span>
          <select
            id="gitlab-identity-member"
            className="h-9 w-full rounded-[var(--radius-input)] border border-input bg-background px-3"
            value={membershipId}
            onChange={(event) => setMembershipId(event.target.value)}
            required
          >
            <option value="">Select member</option>
            {props.members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-label" htmlFor="gitlab-identity-username">
          <span>Exact GitLab username</span>
          <Input
            id="gitlab-identity-username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="username"
            required
          />
        </label>
        <Button type="submit" size="sm" className="self-end" disabled={create.isPending}>
          Bind
        </Button>
      </form>
      {create.error ? <ErrorText error={create.error} /> : null}
      <div className="divide-y divide-border">
        {visibleLinks.length === 0 ? (
          <p className="m-0 py-3 text-label text-muted-foreground">No usernames are bound.</p>
        ) : (
          visibleLinks.map((link) => (
            <div key={link.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div>
                <p className="m-0 text-body">
                  <span className="font-medium">{memberNames.get(link.membershipId) ?? "Former member"}</span> · @
                  {link.displayUsername}
                </p>
                <p className="m-0 text-label text-muted-foreground">{link.state}</p>
              </div>
              <div className="flex gap-2">
                {link.state === "suspended" && link.connectionId === props.connection.id ? (
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => transition.mutate({ id: link.id, action: "reconfirm" })}
                  >
                    Reconfirm
                  </Button>
                ) : null}
                <Button size="xs" variant="destructive" onClick={() => setRemoveConfirmation(link)}>
                  Remove
                </Button>
              </div>
            </div>
          ))
        )}
      </div>
      {transition.error ? <ErrorText error={transition.error} /> : null}
      <Dialog
        open={removeConfirmation !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveConfirmation(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove @{removeConfirmation?.displayUsername}?</DialogTitle>
            <DialogDescription>
              This removes the account binding and stops future personnel routing. A wake already accepted into the
              Inbox may still be delivered once.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRemoveConfirmation(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={transition.isPending}
              onClick={() => {
                if (!removeConfirmation) return;
                transition.mutate(
                  { id: removeConfirmation.id, action: "remove" },
                  { onSuccess: () => setRemoveConfirmation(null) },
                );
              }}
            >
              Remove binding
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ConnectionEditorDialog(props: {
  mode: ConnectionDialog;
  current: GitlabConnectionSummary | null;
  onClose: () => void;
  onSecret: (result: GitlabConnectionSecretResponse) => void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [instanceOrigin, setInstanceOrigin] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async (): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      const input = { displayName, instanceOrigin };
      if (props.mode === "replace") {
        if (!props.current) throw new Error("GitLab connection changed; refresh before replacing it");
        const result = await replaceGitlabConnection(props.current.id, input);
        setDisplayName("");
        setInstanceOrigin("");
        props.onSecret(result);
      } else {
        const result = await createGitlabConnection(input);
        setDisplayName("");
        setInstanceOrigin("");
        props.onSecret(result);
      }
    } catch (submitError) {
      setError(submitError);
    } finally {
      setPending(false);
    }
  };
  const close = () => {
    setError(null);
    setDisplayName("");
    setInstanceOrigin("");
    props.onClose();
  };
  return (
    <Dialog
      open={props.mode !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{props.mode === "replace" ? "Replace GitLab connection" : "Connect GitLab"}</DialogTitle>
          <DialogDescription>
            {props.mode === "replace"
              ? "The current URL and all old follows stop immediately. A stale replace returns a conflict and is never retried automatically."
              : "First Tree stores only a hash of the generated URL bearer and never calls this origin."}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="gitlab-display-name">Name</Label>
            <Input
              id="gitlab-display-name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="Company GitLab"
              required
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="gitlab-origin">GitLab origin</Label>
            <Input
              id="gitlab-origin"
              type="url"
              value={instanceOrigin}
              onChange={(event) => setInstanceOrigin(event.target.value)}
              placeholder="https://gitlab.example.com"
              required
            />
          </div>
          {error ? <ErrorText error={error} /> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {props.mode === "replace" ? "Replace" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function OneTimeSecretDialog(props: {
  secret: OneTimeSecret | null;
  connection: GitlabConnectionSummary | null;
  onClose: () => void;
}) {
  const { status: copyStatus, copy, reset: resetCopy } = useCopyFeedback();
  const close = () => {
    resetCopy();
    props.onClose();
  };
  const adminUrl = props.secret ? gitlabAdminHooksUrl(props.secret.connection.instanceOrigin) : null;
  const readiness = props.connection
    ? gitlabConnectionReadiness(props.connection)
    : GITLAB_CONNECTION_READINESS.waiting;
  return (
    <Dialog
      open={props.secret !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Finish GitLab System Hook setup</DialogTitle>
          <DialogDescription>
            This secret is shown once. Anyone holding it can forge personnel events that route and wake Team agents, so
            configure it only in a trusted GitLab System Hook. Closing this dialog permanently removes it from the UI.
          </DialogDescription>
        </DialogHeader>
        <ol className="m-0 list-decimal space-y-4 pl-5 text-body">
          <li className="space-y-2 pl-1">
            <p className="m-0 font-medium">Open GitLab Admin → System hooks</p>
            <p className="m-0 text-label text-muted-foreground">
              This instance-wide setup requires GitLab administrator access.
            </p>
            {adminUrl ? (
              <Button asChild size="sm" variant="outline">
                <a href={adminUrl} target="_blank" rel="noreferrer">
                  Open GitLab System hooks
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                </a>
              </Button>
            ) : null}
          </li>
          <li className="space-y-2 pl-1">
            <p className="m-0 font-medium">Paste this one-time URL into the URL field</p>
            <p className="m-0 text-label text-muted-foreground">
              No separate Secret token is required. First Tree authenticates the high-entropy URL itself.
            </p>
            <div
              className="rounded-[var(--radius-input)] border border-input bg-muted p-3 font-mono text-label break-all"
              data-testid="gitlab-one-time-webhook-url"
            >
              {props.secret?.webhookUrl}
            </div>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                if (props.secret) void copy(props.secret.webhookUrl);
              }}
            >
              <Copy className="h-4 w-4" aria-hidden />
              {copyStatus === "copied" ? "Copied" : copyStatus === "failed" ? "Copy failed" : "Copy URL"}
            </Button>
          </li>
          <li className="space-y-2 pl-1">
            <p className="m-0 font-medium">Use the default payload and enable both triggers</p>
            <ul className="m-0 list-disc space-y-1 pl-5 text-label text-muted-foreground">
              <li>
                <strong>Push events</strong> provide an early delivery-health signal. First Tree does not route Push
                activity.
              </li>
              <li>
                <strong>Merge request events</strong> enable full-instance MR routing.
              </li>
            </ul>
            <p className="m-0 text-label text-muted-foreground">
              Keep SSL verification enabled and do not use a Custom webhook template.
            </p>
            <p className="m-0 text-label text-muted-foreground">System Hooks do not deliver Issue or Note events.</p>
          </li>
          <li className="space-y-1 pl-1">
            <p className="m-0 font-medium">Add the hook, then create or update a merge request</p>
            <p className="m-0 text-label text-muted-foreground">
              A GitLab test or Push can prove the endpoint was reached. A real merge request event verifies routing.
            </p>
          </li>
        </ol>
        <div className="border-t border-border pt-3" aria-live="polite" data-testid="gitlab-one-time-setup-status">
          <p
            className="m-0 text-body font-medium"
            style={{
              color:
                readiness === GITLAB_CONNECTION_READINESS.routingVerified
                  ? "var(--color-success)"
                  : readiness === GITLAB_CONNECTION_READINESS.needsAttention
                    ? "var(--color-destructive)"
                    : "var(--fg-2)",
            }}
          >
            {CONNECTION_STATUS[readiness]}
          </p>
          {readiness === GITLAB_CONNECTION_READINESS.transportReceived ? (
            <p className="m-0 mt-1 text-label text-muted-foreground">
              Transport is working. First Tree is waiting for a routable merge request event.
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" onClick={close}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const CONFIRM_CONTENT: Record<
  Exclude<ConfirmAction, null>,
  { title: string; description: string; confirm: string; destructive?: boolean }
> = {
  regenerate: {
    title: "Regenerate webhook URL?",
    description: "The old URL stops authenticating immediately. Update the GitLab System Hook manually.",
    confirm: "Regenerate",
    destructive: true,
  },
  delete: {
    title: "Delete GitLab connection?",
    description: "The URL, entity follows, and active identity routing are removed. Historical messages remain.",
    confirm: "Delete",
    destructive: true,
  },
};

function ConfirmationDialog(props: {
  action: ConfirmAction;
  pending: boolean;
  error: unknown;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const content = props.action ? CONFIRM_CONTENT[props.action] : null;
  return (
    <Dialog
      open={props.action !== null}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{content?.title}</DialogTitle>
          <DialogDescription>{content?.description}</DialogDescription>
        </DialogHeader>
        {props.error ? <ErrorText error={props.error} /> : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            variant={content?.destructive ? "destructive" : "default"}
            disabled={props.pending}
            onClick={props.onConfirm}
          >
            {content?.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PageStatus(props: { children: string; error?: boolean }) {
  return (
    <div
      className={props.error ? "text-body text-destructive" : "text-body text-muted-foreground"}
      style={{ padding: "var(--sp-5)" }}
    >
      {props.children}
    </div>
  );
}
function EmptyRow({ children }: { children: string }) {
  return <p className="m-0 py-4 text-body text-muted-foreground">{children}</p>;
}
function ErrorText({ error }: { error: unknown }) {
  return <p className="m-0 text-label text-destructive">{errorMessage(error)}</p>;
}
function errorMessage(error: unknown): string {
  return error instanceof ApiError && error.status === 409
    ? `${error.message}. Refresh before trying again.`
    : error instanceof Error
      ? error.message
      : "Request failed";
}
function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function isNewerConnection(candidate: GitlabConnectionSummary, baseline: GitlabConnectionSummary): boolean {
  const candidateUpdatedAt = Date.parse(candidate.updatedAt);
  const baselineUpdatedAt = Date.parse(baseline.updatedAt);
  return (
    !Number.isNaN(candidateUpdatedAt) && !Number.isNaN(baselineUpdatedAt) && candidateUpdatedAt > baselineUpdatedAt
  );
}

function gitlabAdminHooksUrl(instanceOrigin: string): string {
  return new URL("/admin/hooks", instanceOrigin).toString();
}
