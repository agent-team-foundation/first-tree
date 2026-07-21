---
id: release-cross-process-boot-health
description: Validate that the production server image boots, self-runs migrations, and serves a healthy cross-process stack (server + database + web SPA).
areas: [cross-surface]
surfaces: [server, web, shared]
---

# Release Cross-Process Boot And Health

## Goal

Confirm that first-tree at a release candidate ref boots as the **production Docker image** (the actual shipped artifact),
self-runs database migrations, and serves a healthy cross-process stack over its real HTTP boundary.

This is the layer `system/cloud/release/verification.md` marks as unguarded by automated tests: real server boot,
migration state, and health across the server/database/web process lines. Use this case for release-candidate QA. It is a
boot-and-health smoke, not a full protocol or feature test.

## Preconditions

- Run inside an isolated Docker + git-worktree run cell built from the target ref, not the operator's checkout.
- Docker is available and can build the repository `Dockerfile` and run Compose.
- The production image is a `NODE_ENV=production` boot. It fails closed without the production secret/URL config, so the
  run cell must provide throwaway run-local values for `FIRST_TREE_JWT_SECRET`, `FIRST_TREE_ENCRYPTION_KEY`
  (32 bytes as hex-64 or base64url-43), and `FIRST_TREE_PUBLIC_URL`, plus `FIRST_TREE_DATABASE_URL` for the isolated
  Postgres. Do not set a partial GitHub App block (all-or-nothing).
- Do not reuse host Postgres, host credentials, or the operator's `.env`.

## Operate

- `operate environment`: build the shipped artifact from the target ref, e.g.
  `docker build -t ftqa-server:<ref> --build-arg FIRST_TREE_GIT_SHA=<ref> .`
- `operate environment`: bring up an isolated Postgres plus the built image under a unique Compose project, binding the
  server to a loopback dynamic host port; the server bootstrap runs migrations itself on boot.
- `operate http-api`: from the host, request the health surfaces across the process boundary.

If the build tooling or Compose flags differ for the target ref, record the exact commands in the QA plan and report.

## Observe

- `observe service-log`: server boot log shows the migration stage completing and the listen line
  (e.g. `runMigrations` stage `done`, `migrations applied`, `Server listening on 0.0.0.0:8000`).
- `observe container-state`: `docker compose ps` shows server and postgres `Up (healthy)` (the image `HEALTHCHECK`
  probes `/healthz`).
- `observe http-api`: `/healthz` returns a 200 liveness body (`{"status":"ok"}`).
- `observe http-api`: `/readyz` returns 200 with `ready: true`, `db: "connected"`, and boot stages (including
  `runMigrations`) marked `done`.
- `observe http-api`: `/api/v1/health` returns 200 with database connectivity (`{"status":"ok","db":"connected"}`). Note
  the real DB-health route lives under the `/api/v1` prefix; bare `/health` correctly falls through to the web SPA.
- `observe http-api`: `GET /` returns the web SPA `index.html`, confirming the server image serves the built web dist.

If the health payload shape changes during product work, follow the current typed schema but keep the evidence focused on
the same behavior: the production image boots, migrates, connects to the database, and serves the SPA.

## Expected Result

`PASS`: the production image built at the target ref, booted with migrations applied, reported live + ready + database
connected across the process boundary, and served the web SPA, with server and database containers healthy.

`FAIL`: a reproducible product defect — image build failure attributable to the ref, migration failure on boot, a health
surface returning unhealthy/incorrect status, the SPA not served, or the server crashing at boot with valid config.

`BLOCKED`: Docker unavailable, the image cannot be built, or the isolated Postgres cannot start.

`INCONCLUSIVE`: health surfaces were partial, unstable, or not attributable to the target ref.

## Evidence

Keep the build log, the server boot log (migration + listen lines), `docker compose ps` health, and the response bodies
for `/healthz`, `/readyz`, `/api/v1/health`, and `GET /`. Redact any secrets from logs before sharing outside the run.
