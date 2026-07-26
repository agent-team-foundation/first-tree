import type {
  CronJob,
  CronPreviewRequest,
  CronPreviewResponse,
  DeleteCronJobResponse,
  ListCronJobsResponse,
  UpdateCronJobRequest,
} from "@first-tree/shared";
import { api } from "./client.js";

/**
 * Cron jobs (Schedules) — Human/Web read + lifecycle surface.
 *
 * Web never creates or edits schedule content: humans ask the owning agent in
 * chat, and the agent drives the Class D routes. This wrapper covers the
 * Class C surface only: chat-scoped list/preview plus owner-gated
 * pause/resume/delete. Every mutation carries the job's current `revision` in
 * the `If-Match` header; the Server answers a stale revision with 409
 * (`CRON_JOB_REVISION_MISMATCH`), which callers turn into a refetch rather
 * than a blind retry.
 */

/** `If-Match: <revision>` — the Server's optimistic-concurrency guard. */
function ifMatch(revision: number): { headers: Record<string, string> } {
  return { headers: { "If-Match": String(revision) } };
}

/** List every schedule whose control Chat is `chatId`. All Chat readers may read. */
export function listChatCronJobs(chatId: string): Promise<ListCronJobsResponse> {
  return api.get<ListCronJobsResponse>(`/chats/${encodeURIComponent(chatId)}/cron-jobs`);
}

/**
 * Compute five future occurrences for a schedule/timezone pair. The Server is
 * the only Croner evaluator — Web never parses cron locally. Used both for a
 * job's expanded "upcoming runs" detail and for the resume dialog's first-run
 * confirmation.
 */
export function previewChatCronJobs(chatId: string, input: CronPreviewRequest): Promise<CronPreviewResponse> {
  return api.post<CronPreviewResponse>(`/chats/${encodeURIComponent(chatId)}/cron-jobs/preview`, input);
}

/** Owner-only lifecycle patch. Web only ever sends `{ state }` in V1. */
export function patchCronJob(jobId: string, body: UpdateCronJobRequest, revision: number): Promise<CronJob> {
  return api.patch<CronJob>(`/cron-jobs/${encodeURIComponent(jobId)}`, body, ifMatch(revision));
}

/**
 * Owner-only hard delete. Removes configuration only — an already accepted or
 * executing trigger is NOT cancelled (`acceptedWorkPreserved` in the response
 * tells the caller whether such work existed).
 */
export function deleteCronJob(jobId: string, revision: number): Promise<DeleteCronJobResponse> {
  return api.delete<DeleteCronJobResponse>(`/cron-jobs/${encodeURIComponent(jobId)}`, ifMatch(revision));
}
