import { customType, index, jsonb, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { clients } from "./clients.js";
import { organizations } from "./organizations.js";

/**
 * `bytea` column type — Drizzle ships pg primitives but not bytea out of the
 * box. Reads come back as Node `Buffer` (postgres-js); writes accept any
 * `Uint8Array`. Used for the small inline avatar image blob; no streaming
 * needed at this size (≤ ~50 KB after client-side resize).
 */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});
// NOTE: members FK is deferred — added via raw SQL in migration to avoid circular import

/** Agent registration. Each agent owns a unique inboxId for message delivery. */
export const agents = pgTable(
  "agents",
  {
    uuid: text("uuid").primaryKey(),
    /** Human-readable identifier. UNIQUE per org. NULL when deleted (releases the name). */
    name: text("name"),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    /** "human" | "agent" */
    type: text("type").notNull(),
    /**
     * Required human-readable label. Defaulted to `name` (or "Unnamed Agent"
     * when both would be null) on create by the service layer — see Phase 2
     * of the agent-naming refactor. Tombstoned rows (status="deleted") keep
     * whatever value they had; only `name` is nulled on delete.
     */
    displayName: text("display_name").notNull(),
    /** Agent UUID to forward @mentions to (e.g. personal assistant) */
    delegateMention: text("delegate_mention"),
    /** Delivery address, auto-generated as inbox_{uuid} */
    inboxId: text("inbox_id").unique().notNull(),
    /** "active" | "suspended" | "deleted". Suspended agents have all API requests rejected. */
    status: text("status").notNull().default("active"),
    /** How this agent was created: "admin-api" | "portal" */
    source: text("source"),
    /** Agent visibility: "private" (manager only) or "organization" (all members) */
    visibility: text("visibility").notNull().default("private"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    /** Member who manages this agent (NOT NULL after 0019 unified-user-token migration) */
    managerId: text("manager_id").notNull(),
    /**
     * Physical client this agent is pinned to. Nullable for human agents (no
     * runtime). For non-human agents it is set once (NULL → ID, on creation or
     * first claim) through the generic bind/PATCH paths. Later moves are only
     * allowed through the managed runtime-switch flow, which suspends the
     * agent, evicts sessions, and re-converges the local runtime.
     */
    clientId: text("client_id").references(() => clients.id, { onDelete: "restrict" }),
    /**
     * Runtime provider that drives this agent (e.g. `"claude-code"`, `"codex"`).
     * NOT NULL; defaults to `"claude-code"` for backward compatibility with
     * rows created before 0026.
     */
    runtimeProvider: text("runtime_provider").notNull().default("claude-code"),
    /**
     * Manager-selected avatar color token. One of "hue-0".."hue-7"
     * (matching --avatar-hue-* CSS tokens). NULL means "auto" — the web
     * client falls back to the deterministic djb2 hash of `uuid`.
     */
    avatarColorToken: text("avatar_color_token"),
    /**
     * Inline avatar image bytes. Stored as `bytea` directly (no object
     * storage) since the client always pre-resizes to 256×256 WEBP
     * (typically < 50 KB). NULL when the manager hasn't uploaded one;
     * the renderer falls back to color + initial.
     */
    avatarImageData: bytea("avatar_image_data"),
    /** Mime type for `avatar_image_data` — e.g. "image/webp". NULL iff data is NULL. */
    avatarImageMime: text("avatar_image_mime"),
    /**
     * Last time the avatar image was uploaded. Used as a cache-busting
     * suffix on the public image URL so the browser refetches after an
     * edit. NULL iff data is NULL.
     */
    avatarImageUpdatedAt: timestamp("avatar_image_updated_at", { withTimezone: true }),
    /**
     * Object-storage key of the avatar image (`avatars/<uuid>`, overwritten
     * in place on re-upload). NULL when no avatar is set or the image still
     * sits in the legacy `avatar_image_data` bytea (pre-migration). Avatars
     * are NOT `attachments` rows: 1:1 with the agent, bounded by the 512 KiB
     * cap, and replaced rather than accumulated — so they carry no quota or
     * reference-lifecycle accounting.
     */
    avatarObjectKey: text("avatar_object_key"),
    /**
     * Agent-reported skill (slash-command) list. Discovered by the daemon by
     * scanning the agent runtime's skill directories (~/.claude/skills,
     * <repo>/.claude/skills, plugin skill dirs) and uploaded via
     * `PATCH /api/v1/agents/:uuid/skills`. Consumed by the web composer to
     * render the `/`-triggered slash-command popover after the user
     * @mentions this agent. Default `[]` keeps existing rows valid.
     */
    skills: jsonb("skills").$type<Array<Record<string, unknown>>>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_agents_org").on(table.organizationId),
    index("idx_agents_manager").on(table.managerId),
    index("idx_agents_visibility_org").on(table.organizationId, table.visibility),
    index("idx_agents_client").on(table.clientId),
    unique("uq_agents_org_name").on(table.organizationId, table.name),
  ],
);
