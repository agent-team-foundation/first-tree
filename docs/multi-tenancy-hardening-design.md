# Multi-Tenancy Hardening + Legacy Cleanup — Design Doc

**Status:** Draft — awaiting approval
**Scope:** Single PR combining two originally separate tracks.

## Goals

1. Close the `clients` table cross-org isolation gap (Rule R-RUN currently only verifies `userId`, not `organizationId`).
2. Drop the dead `agents.cloud_user_id` column that was left over from the cloud multi-tenancy phase.
3. Mark `packages/shared` as internal (`private: true`) now that it has no external npm consumers.
4. Update `AGENTS.md` to reflect the unified Hub product direction.

## Non-goals

- User registration / signup flow
- Email/password vs OAuth design
- Invite system
- Multi-org switching UX (will become a `first-tree profile` CLI feature later)
- Hardening indirect-isolation tables (`messages`, `inbox_entries`, `session_events`, `adapter_*`, etc.) — deferred until the product team lays out the multi-tenant product plan.

## Design principles

- **A client is bound to exactly one org for its lifetime.** Switching orgs on the same machine is modeled as "abandon the old client and register a new one" — never as "edit the existing client's org".
- **Server is the source of truth.** CLI does not cache `organizationId` locally for validation; it relies on the server to reject mismatched connections with a distinguishable error code.
- **Migrations are zero-assumption about production state where possible; guarded where not.** The backfill uses a `count(organizations) = 1` guard so the migration is safe on fresh installs, current production, and fails loudly (rather than silently misassigning) in multi-org environments that somehow reach it without prior backfill.

## Decisions (confirmed with product owner)

- CLAUDE.md is a symlink to AGENTS.md — edit AGENTS.md only.
- Migration pattern: single generated migration file with DML appended manually (drizzle-kit generates the DDL, we append backfill + `SET NOT NULL` below it). This is distinct from hand-editing historical migrations, which remains forbidden.
- On CLI org-mismatch re-registration, back up the old `client-config.json` to `client-config.json.bak` before writing the new config.
- Both originally-planned PRs (cleanup + clients org scoping) ship as one PR.

## Change list

### A1. Docs: AGENTS.md wording update

File: `AGENTS.md` (CLAUDE.md follows via symlink).

**Monorepo Structure section** — mark shared as internal:

```diff
-`packages/shared/` — `@first-tree/shared` — Zod schemas + types + config system (published)
+`packages/shared/` — `@first-tree/shared` — Zod schemas + types + config system (internal, not published)
```

**Versioning section** — drop the shared bump rule, add shared to the inert list:

```diff
-- **Bump `packages/shared`** only when its externally-importable surface (exported Zod schemas, types, constants) changes.
-- **Never bump** `private: true` packages (`client` / `server` / `web`) — `tsdown` inlines them into the `command` tarball; their `version` is inert.
+- **Never bump** `private: true` packages (`shared` / `client` / `server` / `web`) — `tsdown` inlines them into the `command` tarball; their `version` is inert.
```

### A2. Mark `packages/shared` as private

File: `packages/shared/package.json`.

```diff
 {
   "name": "@first-tree/shared",
+  "private": true,
   "version": "0.2.1",
   ...
-  "publishConfig": {
-    "access": "public"
-  },
-  "files": [
-    "dist",
-    "src"
-  ],
```

`exports`, `scripts`, `dependencies` untouched — internal consumers continue to work.

### A3. Drop `agents.cloud_user_id`

Dead column: defined in schema, selected in 3 service projections, never written by any code path.

**Schema** — `packages/server/src/db/schema/agents.ts:27-28`:

```diff
-    /** Control-plane user association (nullable, cloud-only) */
-    cloudUserId: text("cloud_user_id"),
```

**Zod** — `packages/shared/src/schemas/agent.ts:93-94`:

```diff
-  /** Control-plane user association (nullable, cloud-only) */
-  cloudUserId: z.string().nullable().optional(),
```

**Service projections** — `packages/server/src/services/agent.ts:292, 343, 397` — delete `cloudUserId: agents.cloudUserId,` at each site.

**Migration** — included in the combined migration file (see B1).

### B1. `clients` table: add `organizationId`

**Schema** — `packages/server/src/db/schema/clients.ts`:

```diff
+import { organizations } from "./organizations.js";

 export const clients = pgTable(
   "clients",
   {
     id: text("id").primaryKey(),
     userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
+    /** Org this client is bound to. A client belongs to exactly one org for its lifetime. */
+    organizationId: text("organization_id")
+      .notNull()
+      .references(() => organizations.id),
     ...
   },
-  (table) => [index("idx_clients_user").on(table.userId)],
+  (table) => [
+    index("idx_clients_user").on(table.userId),
+    index("idx_clients_org").on(table.organizationId),
+  ],
 );
```

**Migration** — single generated file. Exact filename determined by `drizzle-kit generate`. Contents:

```sql
-- Auto-generated by drizzle-kit: drop cloud_user_id + add clients.organization_id
ALTER TABLE "agents" DROP COLUMN "cloud_user_id";
ALTER TABLE "clients" ADD COLUMN "organization_id" text;
ALTER TABLE "clients" ADD CONSTRAINT "clients_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");
CREATE INDEX "idx_clients_org" ON "clients" ("organization_id");

-- Manually appended: backfill clients.organization_id.
-- Safe for fresh installs (clients table is empty; UPDATE affects 0 rows).
-- Safe for current production (exactly one org; backfills all clients to it).
-- Loudly fails on multi-org environments that reach this migration without
-- prior manual backfill: guard skips the UPDATE, then SET NOT NULL throws on
-- the remaining NULL rows, blocking the migration until an operator backfills.
UPDATE "clients"
SET "organization_id" = (SELECT "id" FROM "organizations" LIMIT 1)
WHERE "organization_id" IS NULL
  AND (SELECT count(*) FROM "organizations") = 1;

ALTER TABLE "clients" ALTER COLUMN "organization_id" SET NOT NULL;
```

> **Note on the drizzle-kit workflow:** we define the schema with `.notNull()` first, run `pnpm --filter @first-tree/server db:generate`, then manually append the `UPDATE` between the `ADD COLUMN` and `SET NOT NULL` (drizzle-kit will generate both DDL steps; we just insert the backfill between them). AGENTS.md's "never hand-edit migrations" rule targets already-committed history; appending DML to a freshly generated file is standard practice.

### B2. R-RUN: add org check + `ClientOrgMismatchError`

**New error** — location TBD (wherever other domain errors live). Must carry a machine-readable `code`:

```typescript
export class ClientOrgMismatchError extends Error {
  readonly code = "CLIENT_ORG_MISMATCH";
  constructor(message: string) {
    super(message);
    this.name = "ClientOrgMismatchError";
  }
}
```

**R-RUN update** — in `packages/server/src/services/agent.ts`, the `assertClientOwner` (or equivalent) check gains an org assertion:

```typescript
// Existing userId check
if (client.userId !== jwt.sub) {
  throw new UnauthorizedError("client not owned by this user");
}
// New org check
if (client.organizationId !== jwt.organizationId) {
  throw new ClientOrgMismatchError(
    `client ${client.id} belongs to a different org`,
  );
}
```

**API mapping** — the WebSocket handler / HTTP error mapper translates `ClientOrgMismatchError` to HTTP 403 with body `{ code: "CLIENT_ORG_MISMATCH", message }` so the CLI can distinguish this from a generic 403.

### B3. Client registration: write `organizationId`

In the server-side `client:register` handler (exact file TBD — likely under `packages/server/src/ws/` or `packages/server/src/services/clients.ts`), during the INSERT or UPSERT of a new clients row, set `organization_id` from the verified JWT's `organizationId` claim.

### B4. CLI: detect mismatch → interactive reprompt → re-register

Locations TBD — likely in `packages/client/src/runtime/bootstrap.ts` (the connect flow) or `apps/cli/src/core/` (the onboard flow).

**Behavior:**

1. CLI reads local `clientId` from `client.yaml` (if present).
2. CLI attempts WS connect with `{ clientId, jwt }`.
3. On `CLIENT_ORG_MISMATCH` response:
   a. Server error message already includes enough context (the clientId). Richer org names can be added later if needed.
   b. Show the prompt:

      ```
      ⚠️  This machine is registered as a client in a different organization.
          Server message: Client "{clientId}" is bound to a different organization.

      ? Rotate the local client identity and register fresh? (Y/n)
      ```

   c. On Y: back up `client.yaml` to `client.yaml.bak`, write a new auto-generated `client.id` to `client.yaml`, print the exact command to re-run, and exit 0. The follow-up run registers fresh under the new clientId.
   d. On N: exit 1 cleanly. Credentials are not modified.
   e. In managed (launchd / systemd) mode the prompt is skipped — rotation
      is automatic and recorded as a pino `warn` for audit. The supervisor
      restarts the process on the new identity.

**Entry points that catch this:**

- `first-tree daemon start` — the most common path; rotate + ask operator to re-run.
- `first-tree login <token> [--no-start]` — inline path after credential switch; same rotate + re-run flow, rerun command includes the connect token and any `--no-start` flag the user originally supplied.

## File change summary

| File | Change |
|---|---|
| `AGENTS.md` | A1 wording updates |
| `packages/shared/package.json` | A2 private: true |
| `packages/server/src/db/schema/agents.ts` | A3 drop `cloudUserId` |
| `packages/shared/src/schemas/agent.ts` | A3 drop `cloudUserId` Zod field |
| `packages/server/src/services/agent.ts` | A3 drop 3× projections; B2 add org check in R-RUN |
| `packages/server/src/db/schema/clients.ts` | B1 add `organizationId` column + index |
| `packages/server/drizzle/00XX_*.sql` | Combined migration: A3 drop column + B1 add column/backfill/NOT NULL |
| `packages/server/src/errors.ts` (TBD) | B2 new `ClientOrgMismatchError` |
| `packages/server/src/ws/*` or `services/clients.ts` (TBD) | B3 write `organizationId` on register |
| `packages/server/src/ws/*` (TBD) | B2 map `ClientOrgMismatchError` → 403 + code |
| `packages/client/src/runtime/bootstrap.ts` or `apps/cli/src/core/*` (TBD) | B4 mismatch handling + interactive prompt + backup |
| Tests | Integration coverage for R-RUN cross-org rejection and CLI re-register flow |

"TBD" = path confirmed during implementation after reading the relevant code.

## Risk and rollback

- **Highest-risk change:** R-RUN modification. Covered by new integration tests (two users × two orgs, verify no cross-org client access).
- **Migration rollback:** if `SET NOT NULL` fails in an unexpected environment, the migration aborts before that step leaves any permanent state. Down migration (to be generated by drizzle-kit) drops the column, restoring the prior schema.
- **CLI breakage risk:** low — mismatch path is new behavior; existing single-org flows are unaffected because there is no mismatch to trigger it.

## Test plan

1. `pnpm check && pnpm typecheck` pass.
2. Existing Vitest suites pass.
3. New integration tests:
   - Same user registered in two orgs (A, B). Client created under org A. JWT for org B cannot operate client A (R-RUN rejects with `CLIENT_ORG_MISMATCH`).
   - Fresh install path: empty DB → migration applies cleanly → first client registration writes `organizationId`.
4. Manual CLI dry-run:
   - Log in, connect — normal path still works (no mismatch).
   - Manually swap `credentials.json` to a JWT for a different org → run `first-tree login` → verify interactive prompt appears, backup is created, new client is registered.

## Sequencing

1. Apply schema changes (agents.ts, clients.ts).
2. Run `db:generate` to produce the migration file, then append the backfill DML between the generated `ADD COLUMN` and `SET NOT NULL`.
3. Update Zod schemas and service projections.
4. Implement error class + R-RUN org check + API mapping.
5. Update client registration path to write `organizationId`.
6. Implement CLI mismatch detection + prompt + backup.
7. Write integration tests.
8. Update AGENTS.md, mark shared private.
9. `pnpm check && pnpm typecheck`, run full test suite.

Branch name suggestion: `feat/clients-org-scoping`.
