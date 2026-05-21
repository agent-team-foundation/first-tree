import { index, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";
import { users } from "./users.js";

/**
 * Per-organization settings, keyed by `(organization_id, namespace)`.
 *
 * One row holds an entire group of related config as a JSONB blob — schema
 * for each namespace lives in `@first-tree/shared`
 * (`ORG_SETTINGS_NAMESPACES`) and is enforced by the service layer on every
 * read/write. Adding a new config group means registering a new namespace +
 * Zod schema in shared; the DB does not change.
 *
 * `version` is reserved for future optimistic locking (PUT with If-Match)
 * and is currently set unconditionally. We keep it on the table from day
 * one so tightening to compare-and-swap later is a code-only change.
 *
 * Sensitive fields inside `value` are AES-256-GCM-encrypted at the service
 * layer using `crypto.ts`'s `encryptValue` / `decryptValue` — same pattern
 * as `adapter_configs`.
 */
export const organizationSettings = pgTable(
  "organization_settings",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** e.g. "context_tree" | "source_repos"; validated by shared registry. */
    namespace: text("namespace").notNull(),
    /** Whole-group config JSON; schema-validated by namespace at the service layer. */
    value: jsonb("value").$type<Record<string, unknown>>().notNull().default({}),
    /** Reserved for optimistic locking; not enforced yet. */
    version: integer("version").notNull().default(0),
    /** User id of last writer; null if seeded by the migration helper. */
    updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.namespace] }),
    index("idx_org_settings_namespace").on(table.namespace),
  ],
);
