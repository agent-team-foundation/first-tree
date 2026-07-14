import { z } from "zod";
import { githubEntityTypeSchema } from "./chat-metadata.js";
import { scmIngressContextSchema } from "./scm-source.js";

/**
 * Why a participant ended up in the normalized SCM event's `targets` list. `subscribed`
 * is reserved for the `(human, delegate, entity)` row already present in
 * `github_entity_chat_mappings` — it lives on the audience target, not on
 * an `involves` entry, which is why it doesn't appear here.
 */
export const INVOLVE_REASONS = ["mentioned", "review_requested", "assigned"] as const;
export const involveReasonSchema = z.enum(INVOLVE_REASONS);
export type InvolveReason = z.infer<typeof involveReasonSchema>;

/**
 * Stable kind tag that downstream consumers (delivery, card rendering)
 * read in place of the provider `(eventType, action)` pair. The adapter collapses
 * GitHub's wider action vocabulary into this set so callers don't have to
 * special-case every action string.
 *
 * Historical-compat note: `"merged"` is no longer emitted by Stage 1
 * (`buildPullRequestRule` drops `closed` outright). It's retained in the
 * enum so Zod validation of historical card metadata persisted in the
 * messages table continues to pass. `"closed"` and `"reopened"` are still
 * actively emitted by `buildIssuesRule`.
 */
export const NORMALIZED_EVENT_KINDS = [
  "opened",
  "edited",
  "closed",
  "merged",
  "reopened",
  "commented",
  "review_requested",
  "reviewed",
  "review_comment",
  "synchronized",
  "commit_commented",
  "assigned",
  "other",
] as const;
export const normalizedEventKindSchema = z.enum(NORMALIZED_EVENT_KINDS);
export type NormalizedEventKind = z.infer<typeof normalizedEventKindSchema>;

const normalizedScmEntitySchema = z.object({
  type: githubEntityTypeSchema,
  projectKey: z.string().min(1),
  key: z.string().min(1),
  title: z.string().optional(),
  url: z.string().optional(),
});

const normalizedScmActorSchema = z.object({
  externalUsername: z.string().min(1),
  isBot: z.boolean(),
});

const normalizedScmTargetSchema = z.object({
  externalUsername: z.string().min(1),
  reason: involveReasonSchema,
});

const normalizedSurfaceSchema = z.object({
  title: z.string(),
  body: z.string(),
  url: z.string(),
});

const normalizedRelatedRefSchema = z.object({
  type: z.literal("issue"),
  key: z.string().min(1),
});

/**
 * Provider-neutral output of an SCM adapter. Pure data; no DB, chat, raw
 * payload, or provider credential references. Carries everything the shared
 * processing seam needs to claim the request and everything provider-owned
 * audience/delivery adapters need to route and render it.
 */
export const normalizedScmEventSchema = scmIngressContextSchema.extend({
  eventType: z.string().min(1),
  action: z.string().nullable(),
  entity: normalizedScmEntitySchema,
  actor: normalizedScmActorSchema,
  kind: normalizedEventKindSchema,
  targets: z.array(normalizedScmTargetSchema),
  surface: normalizedSurfaceSchema,
  relatedRefs: z.array(normalizedRelatedRefSchema),
});
export type NormalizedScmEvent = z.infer<typeof normalizedScmEventSchema>;

/**
 * Why the recipient is being told about this event. `subscribed` covers
 * the persistent-subscription path (DP1); `mentioned` / `review_requested`
 * / `assigned` mirror the matching `InvolveReason` values for fresh
 * involvement.
 */
export const GITHUB_EVENT_CARD_REASONS = ["mentioned", "review_requested", "assigned", "subscribed"] as const;
export const githubEventCardReasonSchema = z.enum(GITHUB_EVENT_CARD_REASONS);
export type GithubEventCardReason = z.infer<typeof githubEventCardReasonSchema>;

/**
 * Content payload for a `card` message with `type: "github_event"`. The
 * legacy `github_mention` card stays renderable for historical messages;
 * all newly emitted GitHub-driven cards use this shape.
 */
export const githubEventCardSchema = z.object({
  type: z.literal("github_event"),
  reason: githubEventCardReasonSchema,
  event: z.string().min(1),
  action: z.string().nullable(),
  kind: normalizedEventKindSchema,
  repository: z.string(),
  sender: z.string(),
  title: z.string(),
  body: z.string(),
  url: z.string(),
  entity: z.object({
    type: githubEntityTypeSchema,
    key: z.string().min(1),
    url: z.string().nullable(),
  }),
  mentionedUser: z.string().optional(),
});
export type GithubEventCard = z.infer<typeof githubEventCardSchema>;
