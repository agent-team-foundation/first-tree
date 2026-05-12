# drizzle/probes

Read-only SQL artifacts that **accompany** a migration but are **not**
themselves migrations. drizzle-kit ignores everything outside
`meta/_journal.json`, so files in this subdirectory are never
auto-applied — they exist purely for ops to run by hand against a real
database during a deploy window.

## Naming convention

```
NNNN_<migration-tag>.<phase>.sql
```

Where `<phase>` is one of:

- `pre-flight` — run **before** the migration enters prod. Validates the
  *input* data (orphan rows, invariant violations, projection drift).
  Migration must not proceed if a probe returns unexpected rows.
- `post-deploy` — run **after** the migration has been applied.
  Validates the *output* (row counts, query plans, index usage).

## Current artifacts

| File | Migration | Purpose |
|------|-----------|---------|
| `0038_chat_membership_user_state.pre-flight.sql` | 0038 | Collision + orphan probe before the legacy → new-table back-fill. See first-tree-context proposal §9.1. |
| `0038_chat_membership_user_state.post-deploy.sql` | 0038 | Row-count + speaker-wins + EXPLAIN ANALYZE + index-scan + badge-consistency checks after 0038 has run. |

## How to run

```bash
psql "$DATABASE_URL" \
  -f packages/server/drizzle/probes/0038_chat_membership_user_state.pre-flight.sql \
  > 0038.pre-flight.staging.txt
```

Archive the `.txt` somewhere reachable (PR comment, ops drive). Both
staging and prod runs are expected before each phase advances.
