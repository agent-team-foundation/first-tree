import { desc } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";

/** Communication container. All messages between agents flow within a Chat. */
export const chats = pgTable(
  "chats",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    /** "direct" | "group" */
    type: text("type").notNull().default("direct"),
    topic: text("topic"),
    description: text("description"),
    /**
     * Freshness for `description` specifically — the data behind the task
     * summary's "X ago" line and its unread/auto-expand logic. Deliberately
     * distinct from the row-level `updatedAt`, which a topic edit or a
     * projection write also bumps; only a *real* description change stamps it
     * (see `updateChatMetadata`). NULL until the first description write lands;
     * existing rows are intentionally NOT backfilled — we surface "no freshness
     * yet" rather than fabricate a time we do not truly have.
     */
    descriptionUpdatedAt: timestamp("description_updated_at", { withTimezone: true }),
    lifecyclePolicy: text("lifecycle_policy").default("persistent"),
    /**
     * Decision-inert column. First Tree keeps a single group-chat model — there is no
     * sub-chat / nested-chat product layer (see first-tree-context PR #281).
     * The column is retained as schema scaffolding only; the business layer
     * never writes a non-null value and `listMeChats` defensively filters
     * `parent_chat_id IS NULL` so any historical row stays hidden from the
     * conversation list. Do NOT reintroduce nested-chat semantics here.
     */
    parentChatId: text("parent_chat_id"),
    /**
     * Idempotency key for the onboarding kickoff chat (`POST /me/onboarding/kickoff`).
     * Set to `<humanAgentId>:<targetAgentId>` ONLY for the chat created by the
     * onboarding finale; NULL for every other chat. The unique index below makes
     * re-running kickoff (reopened tab, retry, build-tree recovery) reuse the one
     * existing chat via `INSERT ... ON CONFLICT DO NOTHING` instead of creating a
     * duplicate. Postgres treats multiple NULLs as distinct, so ordinary chats —
     * including additional chats a user opens with the same agent later — never
     * collide. Mirrors the 1:1 binding pattern used by
     * `github_app_installations.hub_organization_id`.
     */
    onboardingKickoffKey: text("onboarding_kickoff_key"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    /**
     * Conversation-list projection columns (chat-first workspace).
     * Maintained on write by the post-fan-out projection step in
     * `services/chat-projection.ts`. Backfilled by migration 0030.
     */
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    lastMessagePreview: text("last_message_preview"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_chats_org_last_message").on(table.organizationId, desc(table.lastMessageAt)),
    uniqueIndex("uq_chats_onboarding_kickoff_key").on(table.onboardingKickoffKey),
  ],
);
