import type { AttentionMetadata } from "@first-tree/shared";
import { boolean, index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * NHA (Need Human Attention) — backing store for the M1 末 primitive.
 *
 * One row per Attention raised by an agent against exactly one human in a
 * chat. The Attention is either a **request** (`requires_response=true`,
 * stays `open` until the human responds) or a **notification**
 * (`requires_response=false`, written as `closed` on creation so the
 * "needs your reply" queue stays clean).
 *
 * Per the team's "integrity in service layer" convention there are NO
 * foreign-key constraints — `services/attention.ts` validates that:
 *
 *   - origin_agent is a speaker of origin_chat (otherwise 403)
 *   - target_human resolves to an `agents` row with `type='human'` and is
 *     a member of origin_chat (otherwise 400 / 409 respectively)
 *   - respond is authored by target_human (otherwise 403)
 *   - cancel is authored by origin_agent (otherwise 403)
 *   - closed records are immutable (otherwise 409)
 *
 * Modification flow is cancel + raise — there is no SUPERSEDED state and
 * no replacement chain. The new Attention's `body` carries the human-
 * readable relationship to the cancelled one.
 *
 * Ids are UUID v7 generated app-side via `src/uuid.ts::uuidv7` so the
 * primary key is time-ordered and the `created_at` ordering is stable
 * across same-millisecond inserts.
 */
export const attentions = pgTable(
  "attentions",
  {
    /** UUID v7, generated app-side via `uuidv7()`. */
    id: text("id").primaryKey(),
    /** Agent that raised the Attention. Must be a speaker of origin_chat. */
    originAgentId: text("origin_agent_id").notNull(),
    /** Chat the Attention is anchored to. */
    originChatId: text("origin_chat_id").notNull(),
    /** Single human target. Service enforces `agents.type='human'` + chat-membership. */
    targetHumanId: text("target_human_id").notNull(),
    subject: text("subject").notNull(),
    body: text("body").notNull().default(""),
    /** true = request (expects respond), false = notification (closed on creation). */
    requiresResponse: boolean("requires_response").notNull().default(false),
    /** 'open' | 'closed'. */
    state: text("state").notNull().default("open"),
    /** Human-supplied response text. NULL until responded. */
    response: text("response"),
    respondedBy: text("responded_by"),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    /** True iff this Attention was cancelled by the origin agent. */
    cancelled: boolean("cancelled").notNull().default(false),
    cancelledReason: text("cancelled_reason"),
    /**
     * `AttentionMetadata` bag. Convention-driven (top-level options /
     * multi-question / timeoutHint / tags / …); the shared schema uses
     * `.catchall(z.unknown())` so newer agents can roll forward without a
     * server bump. Stored as JSONB; defaults to `{}`.
     */
    metadata: jsonb("metadata").$type<AttentionMetadata>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (table) => [
    /** Per-human inbox lookup: "what's open for me right now". */
    index("idx_attentions_target_open").on(table.targetHumanId, table.state),
    /** Per-chat lookup: "what's open in this chat". */
    index("idx_attentions_chat_open").on(table.originChatId, table.state),
    /** Per-origin audit lookup: "what has this agent raised, newest first". */
    index("idx_attentions_origin").on(table.originAgentId, table.createdAt),
  ],
);
