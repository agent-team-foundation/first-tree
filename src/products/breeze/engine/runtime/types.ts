/**
 * Runtime-validated types for the shared breeze store.
 *
 * Authoritative spec: `docs/migration/02-inbox-store-schema.md` and
 * `docs/migration/03-status-state-machine.md`. These must round-trip
 * existing `~/.breeze/inbox.json` and `~/.breeze/activity.log` files
 * produced by the Rust `breeze-runner` and the legacy bash scripts.
 *
 * Field ordering and `null` (vs `undefined` / omitted) in inbox entries
 * is load-bearing — the Rust encoder always emits every key and uses
 * JSON `null` for nullable fields. Matching ordering (spec doc 2 §1.1)
 * keeps diffs human-readable when inspecting live files.
 */

import { z } from "zod";

/** The four possible derived statuses for a notification. */
export const BreezeStatusSchema = z.enum(["new", "wip", "human", "done"]);
export type BreezeStatus = z.infer<typeof BreezeStatusSchema>;

/** GitHub GraphQL `state` enum surfaced in the inbox payload. */
export const GhStateSchema = z.enum(["OPEN", "CLOSED", "MERGED"]);
export type GhState = z.infer<typeof GhStateSchema>;

/**
 * Single inbox entry. Matches `entry_to_json` in
 * `first-tree-breeze/breeze-runner/src/fetcher.rs:601-631`.
 *
 * The encoder never omits keys; nullable fields are emitted as JSON `null`.
 */
export const InboxEntrySchema = z.object({
  id: z.string(),
  type: z.string(),
  reason: z.string(),
  repo: z.string(),
  title: z.string(),
  url: z.string(),
  last_actor: z.string(),
  updated_at: z.string(),
  unread: z.boolean(),
  priority: z.number().int(),
  number: z.number().int().nullable(),
  html_url: z.string(),
  gh_state: GhStateSchema.nullable(),
  labels: z.array(z.string()),
  breeze_status: BreezeStatusSchema,
});
export type InboxEntry = z.infer<typeof InboxEntrySchema>;

/** Top-level `inbox.json` shape. */
export const InboxSchema = z.object({
  last_poll: z.string(),
  notifications: z.array(InboxEntrySchema),
});
export type Inbox = z.infer<typeof InboxSchema>;

/**
 * Activity-log event kinds emitted by the Rust fetcher and the shell
 * status-manager. Spec doc 2 §2.
 *
 * The four observed kinds in the wild:
 *   - `new` — fetcher: first-time notification
 *   - `transition` — fetcher or status-manager: breeze_status changed
 *   - `claimed` — status-manager: claim directory acquired
 *   - `poll` — legacy `bin/breeze-poll`: count-of-new per cycle
 *
 * Each event has a small common header (`ts`, `event`, plus per-kind
 * payload). Extra keys are allowed for forward-compatibility but
 * validated for type where present.
 */
const CommonHeader = {
  ts: z.string(),
  id: z.string(),
  type: z.string(),
  repo: z.string(),
  title: z.string(),
  url: z.string(),
};

export const NewEventSchema = z.object({
  event: z.literal("new"),
  ...CommonHeader,
});
export type NewEvent = z.infer<typeof NewEventSchema>;

export const TransitionEventSchema = z.object({
  event: z.literal("transition"),
  ...CommonHeader,
  from: BreezeStatusSchema,
  to: BreezeStatusSchema,
  // Status-manager writes these extra fields; the Rust fetcher does not.
  by: z.string().optional(),
  reason: z.string().optional(),
});
export type TransitionEvent = z.infer<typeof TransitionEventSchema>;

export const ClaimedEventSchema = z.object({
  event: z.literal("claimed"),
  ...CommonHeader,
  by: z.string(),
  action: z.string(),
});
export type ClaimedEvent = z.infer<typeof ClaimedEventSchema>;

export const PollEventSchema = z.object({
  event: z.literal("poll"),
  ts: z.string(),
  count: z.number().int(),
});
export type PollEvent = z.infer<typeof PollEventSchema>;

export const ActivityEventSchema = z.union([
  NewEventSchema,
  TransitionEventSchema,
  ClaimedEventSchema,
  PollEventSchema,
]);
export type ActivityEvent = z.infer<typeof ActivityEventSchema>;

/** Claim directory contents (one subdirectory per notification id). */
export const ClaimSchema = z.object({
  claimed_by: z.string(),
  claimed_at: z.string(),
  action: z.string(),
});
export type Claim = z.infer<typeof ClaimSchema>;

/**
 * Label color/description metadata enforced by `ensure-labels` on a repo.
 * Spec doc 3 §7.
 */
export const BREEZE_LABEL_META = {
  "breeze:new": { color: "0075ca", description: "Breeze: new notification" },
  "breeze:wip": { color: "e4e669", description: "Breeze: work in progress" },
  "breeze:human": {
    color: "d93f0b",
    description: "Breeze: needs human attention",
  },
  "breeze:done": { color: "0e8a16", description: "Breeze: handled" },
} as const satisfies Record<
  string,
  { color: string; description: string }
>;

export const ALL_BREEZE_LABELS = [
  "breeze:new",
  "breeze:wip",
  "breeze:human",
  "breeze:done",
] as const;
export type BreezeLabel = (typeof ALL_BREEZE_LABELS)[number];
