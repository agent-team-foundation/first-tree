import type { ChatParticipantDetail, CronJob, CronPreviewResponse } from "@first-tree/shared";
import { type UseQueryResult, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Pause, Play, Trash2 } from "lucide-react";
import { useState } from "react";
import { ApiError } from "../../../api/client.js";
import { deleteCronJob, listChatCronJobs, patchCronJob, previewChatCronJobs } from "../../../api/cron-jobs.js";
import { useAuth } from "../../../auth/auth-context.js";
import { Button } from "../../../components/ui/button.js";
import { DenseBadge, type DenseBadgeTone } from "../../../components/ui/dense-badge.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog.js";
import { useToast } from "../../../components/ui/toast.js";

/**
 * Schedules section — the chat's cron jobs in the right sidebar.
 *
 * V1 is inspection plus owner lifecycle control only: every Chat reader sees
 * the same schedule facts and prompts (transparency), and only the owning
 * human member gets Pause / Resume / Delete. There is deliberately no Web
 * create/edit form — humans ask the owning agent in chat, and the agent owns
 * schedule content. Mobile stays closed-by-default and never mounts this
 * section.
 *
 * Display language is careful about what the scheduler actually knows:
 * "next run" is the scheduled occurrence, an outstanding trigger was ACCEPTED
 * (durably queued) but may not have started or completed, and nothing here
 * claims delivery or execution is guaranteed.
 */

export function cronJobsQueryKey(chatId: string) {
  return ["chat-right-sidebar", "cron-jobs", chatId] as const;
}

function cronPreviewQueryKey(chatId: string, schedule: string, timezone: string) {
  return ["chat-right-sidebar", "cron-preview", chatId, schedule, timezone] as const;
}

/** Shared chat-scoped query — the sidebar section and the engagement-menu
 *  warning both read this key, so the two call sites dedupe to one request. */
export function useChatCronJobs(chatId: string) {
  const query = useQuery({
    queryKey: cronJobsQueryKey(chatId),
    queryFn: () => listChatCronJobs(chatId),
    // The admin-WS `chat:updated` / `chat:message` branches invalidate this
    // key; the 60s poll is only the self-healing floor for a dropped frame,
    // matching the sibling GitHub/GitLab sections.
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  return {
    items: query.data?.items ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    retry: () => {
      void query.refetch();
    },
  };
}

/** Future-tense counterpart to lib/utils' past-only `formatRelative`. */
export function formatFutureRelative(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diffMs = t - now;
  if (diffMs <= 0) return "due now";
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return "in less than a minute";
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "always" });
  if (minutes < 60) return rtf.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 48) return rtf.format(hours, "hour");
  return rtf.format(Math.round(hours / 24), "day");
}

/**
 * Absolute instant formatted IN THE JOB'S timezone (never silently the
 * browser's) with a short zone name, so `0 9 * * *` in `America/New_York`
 * reads as the wall time the owner actually scheduled.
 */
export function formatAbsoluteInZone(iso: string, timezone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  try {
    // Component options, not dateStyle/timeStyle — the styles are mutually
    // exclusive with an explicit `timeZoneName` and throw on construction.
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: timezone,
      timeZoneName: "short",
    }).format(d);
  } catch {
    // Unknown/invalid stored zone — fall back to an unambiguous UTC instant
    // rather than crashing the rail.
    return d.toISOString();
  }
}

/** Human-readable pause reasons. Auto-pause reasons are server-owned; keep
 *  the mapping here so a new server reason degrades to the raw token instead
 *  of a blank row. */
export function pauseReasonLabel(reason: string | null): string {
  switch (reason) {
    case "user_paused":
      return "Paused by owner";
    case "owner_inactive":
      return "Paused — owner is no longer active";
    case "owner_not_speaker":
      return "Paused — owner is no longer in this chat";
    case "agent_manager_changed":
      return "Paused — the agent's manager changed";
    case "agent_inactive":
      return "Paused — the agent is no longer active";
    case "agent_not_speaker":
      return "Paused — the agent is no longer in this chat";
    case "chat_invalid":
      return "Paused — this chat is no longer valid";
    case "invalid_schedule":
      return "Paused — the schedule is no longer valid";
    case "inbox_state_missing":
      return "Paused — previous trigger state was lost";
    case "owner_chat_deleted":
      return "Paused — the owner deleted this chat";
    case "unsupported_chat_mode":
      return "Paused — unsupported schedule mode";
    default:
      return reason ? `Paused — ${reason}` : "Paused";
  }
}

export function activeJobCount(items: CronJob[]): number {
  return items.filter((job) => job.state === "active").length;
}

function isRevisionConflict(err: unknown): boolean {
  // Branch on the stable machine code, not the bare status: any other 409 is
  // not a stale-revision signal and must not masquerade as one.
  return err instanceof ApiError && err.status === 409 && err.code === "CRON_JOB_REVISION_MISMATCH";
}

export function SchedulesSection({ chatId, participants }: { chatId: string; participants: ChatParticipantDetail[] }) {
  const { memberId } = useAuth();
  const { items, isLoading, isError, retry } = useChatCronJobs(chatId);
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);

  // First load gets an identifiable lightweight row: rendering nothing could
  // read as "this chat has no schedules" while the answer is still unknown.
  if (isLoading) {
    return (
      <section style={{ borderBottom: "var(--hairline) solid var(--border-faint)" }}>
        <div
          className="text-eyebrow"
          style={{ padding: "var(--sp-2_5) var(--sp-3) var(--sp-1)", color: "var(--fg-4)" }}
        >
          Schedules
        </div>
        <div
          className="text-body"
          aria-busy="true"
          style={{ padding: "var(--sp-1_5) var(--sp-2) var(--sp-2)", color: "var(--fg-4)" }}
        >
          Loading schedules…
        </div>
      </section>
    );
  }

  if (isError && items.length === 0) {
    return (
      <section style={{ borderBottom: "var(--hairline) solid var(--border-faint)" }}>
        <div
          className="text-eyebrow"
          style={{ padding: "var(--sp-2_5) var(--sp-3) var(--sp-1)", color: "var(--fg-4)" }}
        >
          Schedules
        </div>
        <div
          className="flex items-center text-body"
          style={{ gap: "var(--sp-2)", padding: "var(--sp-1_5) var(--sp-2) var(--sp-2)", color: "var(--fg-3)" }}
        >
          <span style={{ flex: 1 }}>Schedules could not be loaded.</span>
          <button
            type="button"
            onClick={retry}
            className="inline-flex items-center rounded-[var(--radius-input)] border px-2 py-1"
            style={{ borderColor: "var(--border)", color: "var(--fg)" }}
          >
            Retry
          </button>
        </div>
      </section>
    );
  }

  // Density convention: a chat with no schedules hides the section entirely
  // (same as the GitHub/GitLab bindings sections).
  if (items.length === 0) return null;

  const agentName = (agentId: string): string =>
    participants.find((p) => p.agentId === agentId)?.displayName ?? "Unknown agent";

  return (
    <section style={{ borderBottom: "var(--hairline) solid var(--border-faint)" }}>
      <div className="text-eyebrow" style={{ padding: "var(--sp-2_5) var(--sp-3) var(--sp-1)", color: "var(--fg-4)" }}>
        Schedules <span className="mono">· {activeJobCount(items)}</span>
      </div>
      <div className="flex flex-col" style={{ padding: "0 var(--sp-2) var(--sp-2)", gap: "var(--sp-1)" }}>
        {items.map((job) => (
          <ScheduleRow
            key={job.id}
            chatId={chatId}
            job={job}
            agentDisplayName={agentName(job.agentId)}
            isOwner={memberId !== null && memberId === job.ownerMemberId}
            expanded={expandedJobId === job.id}
            onToggle={() => setExpandedJobId((current) => (current === job.id ? null : job.id))}
          />
        ))}
      </div>
    </section>
  );
}

function ScheduleRow({
  chatId,
  job,
  agentDisplayName,
  isOwner,
  expanded,
  onToggle,
}: {
  chatId: string;
  job: CronJob;
  agentDisplayName: string;
  isOwner: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const stateView = stateBadge(job);
  return (
    <div
      className="flex flex-col"
      style={{ borderRadius: "var(--radius-input)", border: "var(--hairline) solid var(--border-faint)" }}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={`schedule-detail-${job.id}`}
        className="flex items-start text-left transition-colors hover:bg-[var(--bg-hover)]"
        style={{
          gap: "var(--sp-2)",
          padding: "var(--sp-1_5) var(--sp-2)",
          borderRadius: "var(--radius-input)",
          color: "inherit",
        }}
      >
        {expanded ? (
          <ChevronDown
            aria-hidden="true"
            size={14}
            className="shrink-0"
            style={{ marginTop: 3, color: "var(--fg-3)" }}
          />
        ) : (
          <ChevronRight
            aria-hidden="true"
            size={14}
            className="shrink-0"
            style={{ marginTop: 3, color: "var(--fg-3)" }}
          />
        )}
        <span className="flex min-w-0 flex-1 flex-col" style={{ gap: 2 }}>
          <span className="flex items-center" style={{ gap: "var(--sp-1_5)" }}>
            <span className="truncate text-subtitle" style={{ color: "var(--fg)" }} title={job.name}>
              {job.name}
            </span>
            <DenseBadge tone={stateView.tone}>{stateView.label}</DenseBadge>
            {job.outstanding ? (
              <DenseBadge tone="accent" title="A scheduled trigger was accepted and is queued for the agent">
                Trigger {job.outstanding.status}
              </DenseBadge>
            ) : null}
          </span>
          <span className="mono text-label truncate" style={{ color: "var(--fg-3)" }} title={job.schedule}>
            {job.schedule} · {job.timezone}
          </span>
          <span className="text-label" style={{ color: "var(--fg-3)" }}>
            {agentDisplayName}
            {job.state === "active" && job.nextRunAt ? (
              <>
                {" · next "}
                <span title={formatAbsoluteInZone(job.nextRunAt, job.timezone)}>
                  {formatFutureRelative(job.nextRunAt)}
                </span>
              </>
            ) : null}
            {job.state === "paused" ? <> · {pauseReasonLabel(job.stateReason)}</> : null}
          </span>
        </span>
      </button>
      {expanded ? <ScheduleDetail chatId={chatId} job={job} isOwner={isOwner} /> : null}
    </div>
  );
}

function stateBadge(job: CronJob): { label: string; tone: DenseBadgeTone } {
  return job.state === "active" ? { label: "Active", tone: "accent" } : { label: "Paused", tone: "neutral" };
}

function ScheduleDetail({ chatId, job, isOwner }: { chatId: string; job: CronJob; isOwner: boolean }) {
  const preview = useQuery({
    queryKey: cronPreviewQueryKey(chatId, job.schedule, job.timezone),
    queryFn: () => previewChatCronJobs(chatId, { schedule: job.schedule, timezone: job.timezone }),
    // Active and paused jobs both show occurrences (paused is labeled
    // "if resumed"); the resume dialog fetches its own forced-fresh preview.
    staleTime: 30_000,
  });

  return (
    <div
      id={`schedule-detail-${job.id}`}
      className="flex flex-col"
      style={{
        gap: "var(--sp-2)",
        padding: "0 var(--sp-2) var(--sp-2)",
        borderTop: "var(--hairline) solid var(--border-faint)",
      }}
    >
      {/* The full prompt is shared with every reader — it is the schedule's
          durable instruction and must stay inspectable. Whitespace is
          preserved; long content scrolls instead of breaking the rail. */}
      {job.state === "active" && job.nextRunAt ? (
        <div className="text-body" style={{ paddingTop: "var(--sp-2)", color: "var(--fg-2)" }}>
          Next run: {formatFutureRelative(job.nextRunAt)} · {formatAbsoluteInZone(job.nextRunAt, job.timezone)}
        </div>
      ) : null}
      <div style={{ paddingTop: job.state === "active" && job.nextRunAt ? 0 : "var(--sp-2)" }}>
        <div className="text-eyebrow" style={{ color: "var(--fg-4)", paddingBottom: "var(--sp-1)" }}>
          Prompt
        </div>
        <pre
          className="text-body"
          style={{
            margin: 0,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: 200,
            overflowY: "auto",
            color: "var(--fg-2)",
            fontFamily: "inherit",
          }}
        >
          {job.prompt}
        </pre>
      </div>
      <UpcomingRuns job={job} preview={preview} />
      {isOwner ? <OwnerControls chatId={chatId} job={job} /> : null}
    </div>
  );
}

function UpcomingRuns({ job, preview }: { job: CronJob; preview: UseQueryResult<CronPreviewResponse> }) {
  // Paused jobs keep the occurrences visible, qualified as hypothetical:
  // readers still inspect what the schedule WOULD run; only the label
  // changes so nobody mistakes them for committed runs.
  return (
    <div>
      <div className="text-eyebrow" style={{ color: "var(--fg-4)", paddingBottom: "var(--sp-1)" }}>
        {job.state === "paused" ? "Upcoming runs (if resumed)" : "Upcoming runs"}
      </div>
      {preview.isLoading ? (
        <div className="text-body" style={{ color: "var(--fg-3)" }}>
          Computing…
        </div>
      ) : preview.isError ? (
        <div className="text-body" style={{ color: "var(--fg-3)" }}>
          Upcoming runs could not be computed.
        </div>
      ) : (
        <ol className="flex flex-col" style={{ gap: 2, margin: 0, padding: 0, listStyle: "none" }}>
          {(preview.data?.occurrences ?? []).map((occurrence) => (
            <li key={occurrence.at} className="text-label" style={{ color: "var(--fg-3)" }}>
              {formatAbsoluteInZone(occurrence.at, job.timezone)}{" "}
              <span style={{ color: "var(--fg-4)" }}>({occurrence.at})</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function OwnerControls({ chatId, job }: { chatId: string; job: CronJob }) {
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const [resumeOpen, setResumeOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const invalidateSchedules = () => queryClient.invalidateQueries({ queryKey: cronJobsQueryKey(chatId) });

  // A 409 means the UI acted on a stale revision: never blind-retry — refetch
  // the list (fresh revisions), close whatever dialog was open, and tell the
  // owner the state changed under them.
  const onConflict = () => {
    setResumeOpen(false);
    setDeleteOpen(false);
    void invalidateSchedules();
    addToast({
      title: "Schedule changed elsewhere",
      description: "The latest state has been loaded — review it and try again.",
    });
  };

  const patchMut = useMutation({
    mutationFn: (input: { body: { state: "active" | "paused" }; revision: number }) =>
      patchCronJob(job.id, input.body, input.revision),
    onSuccess: (_updated, input) => {
      setResumeOpen(false);
      void invalidateSchedules();
      addToast({ title: input.body.state === "paused" ? "Schedule paused" : "Schedule resumed" });
    },
    onError: (err) => {
      if (isRevisionConflict(err)) {
        onConflict();
      } else {
        addToast({ title: "Couldn't update the schedule", description: "The change wasn't saved — try again." });
      }
    },
  });

  const deleteMut = useMutation({
    mutationFn: (revision: number) => deleteCronJob(job.id, revision),
    onSuccess: () => {
      setDeleteOpen(false);
      void invalidateSchedules();
      addToast({ title: "Schedule deleted" });
    },
    onError: (err) => {
      if (isRevisionConflict(err)) {
        onConflict();
      } else {
        addToast({ title: "Couldn't delete the schedule", description: "Nothing was removed — try again." });
      }
    },
  });

  const mutating = patchMut.isPending || deleteMut.isPending;

  return (
    <div className="flex items-center" style={{ gap: "var(--sp-2)", paddingBottom: "var(--sp-1)" }}>
      {job.state === "active" ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={mutating}
          onClick={() => patchMut.mutate({ body: { state: "paused" }, revision: job.revision })}
          aria-label={`Pause schedule ${job.name}`}
        >
          <Pause aria-hidden="true" size={14} />
          Pause
        </Button>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={mutating}
          onClick={() => setResumeOpen(true)}
          aria-label={`Resume schedule ${job.name}`}
        >
          <Play aria-hidden="true" size={14} />
          Resume
        </Button>
      )}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={mutating}
        onClick={() => setDeleteOpen(true)}
        aria-label={`Delete schedule ${job.name}`}
        style={{ color: "var(--state-error)" }}
      >
        <Trash2 aria-hidden="true" size={14} />
        Delete
      </Button>

      <ResumeDialog
        chatId={chatId}
        job={job}
        open={resumeOpen}
        onOpenChange={setResumeOpen}
        pending={patchMut.isPending}
        onConfirm={() => patchMut.mutate({ body: { state: "active" }, revision: job.revision })}
      />
      <DeleteDialog
        job={job}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        pending={deleteMut.isPending}
        onConfirm={() => deleteMut.mutate(job.revision)}
      />
    </div>
  );
}

function ResumeDialog({
  chatId,
  job,
  open,
  onOpenChange,
  pending,
  onConfirm,
}: {
  chatId: string;
  job: CronJob;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  onConfirm: () => void;
}) {
  // The resume confirmation contract is "see the real first future run, then
  // confirm". This query MUST NOT share the expanded detail's preview cache:
  // that cache can be up to 30s stale, so a cached first occurrence may
  // already be in the past by the time the owner resumes. A dialog-scoped
  // key + staleTime: 0 + always-refetch-on-mount guarantees the displayed
  // time is computed now, by the Server (the only Croner evaluator).
  const preview = useQuery({
    queryKey: ["chat-right-sidebar", "cron-preview-resume", chatId, job.id],
    queryFn: () => previewChatCronJobs(chatId, { schedule: job.schedule, timezone: job.timezone }),
    enabled: open,
    staleTime: 0,
    refetchOnMount: "always",
  });
  const first = preview.data?.occurrences[0];
  // Confirm stays disabled until a FRESH preview has succeeded — resuming
  // without seeing the actual first run is not allowed. On failure the owner
  // gets an explicit Retry; there is no silent "resume anyway" path.
  const confirmDisabled = pending || !preview.isSuccess;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Resume "{job.name}"?</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <DialogDescription style={{ color: "var(--fg-2)" }}>
            The schedule becomes active again on <span className="mono">{job.schedule}</span> ({job.timezone}).
          </DialogDescription>
          {preview.isLoading || preview.isFetching ? (
            <p className="text-body" style={{ color: "var(--fg-2)" }}>
              Computing the first run…
            </p>
          ) : preview.isError ? (
            <div className="space-y-2">
              <p className="text-body" style={{ color: "var(--state-error)" }}>
                The first run time could not be loaded. Resume is only available once it can be shown.
              </p>
              <Button type="button" variant="outline" size="sm" onClick={() => void preview.refetch()}>
                Retry
              </Button>
            </div>
          ) : first ? (
            <p className="text-body" style={{ color: "var(--fg-2)" }}>
              First run: {formatAbsoluteInZone(first.at, job.timezone)}.
            </p>
          ) : null}
          <p className="text-body" style={{ color: "var(--fg-2)" }}>
            Occurrences missed while paused are not replayed — the schedule continues from the next future time.
          </p>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" onClick={onConfirm} disabled={confirmDisabled}>
            {pending ? "Resuming…" : "Resume schedule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({
  job,
  open,
  onOpenChange,
  pending,
  onConfirm,
}: {
  job: CronJob;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete "{job.name}"?</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <DialogDescription style={{ color: "var(--fg-2)" }}>
            This permanently removes the schedule's configuration. It cannot be restored.
          </DialogDescription>
          <p className="text-body" style={{ color: "var(--fg-2)" }}>
            A trigger that was already accepted or is currently running is not cancelled — it may still post to this
            chat.
          </p>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={onConfirm} disabled={pending}>
            {pending ? "Deleting…" : "Delete schedule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
