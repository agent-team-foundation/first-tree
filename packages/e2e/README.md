# `@first-tree-hub/e2e` — cross-process E2E framework

Real-process E2E for Hub: each run boots a fresh PostgreSQL (Docker), spawns
the built server and the unified CLI as **separate Node processes**, and
talks to them over real HTTP + WS. Distinct from the in-process
`packages/server/src/__tests__/*` suite (which uses `fastify.inject` and stays
as the component-level regression net).

Source proposal: [`proposals/hub-local-e2e-framework.20260518.md`][prop] in
the Context Tree.

[prop]: https://github.com/agent-team-foundation/first-tree-context/blob/main/proposals/hub-local-e2e-framework.20260518.md

---

## What ships in M1

Just enough to prove the wiring:

- Doctor + env validation (`pnpm e2e:doctor`).
- Per-run isolated PG (docker compose, tmpfs, random port).
- Spawned `server` + `client --foreground` against that PG.
- Smoke test: `/healthz`, `/`, `/api/v1/health` return OK.

M1 deliberately does **not** drive `chat-send`, agent runtime, GitHub
webhooks, or Feishu — those land in M2 alongside the three mocks
(`github-mock`, `agent-mock`; Feishu coverage stays in-process per F4).

## Hard rules

1. **Not published.** `private: true`. `turbo.json` excludes `packages/e2e/**`
   from the `build` / `typecheck` / `test` cache inputs. The published CLI
   tarball (`@agent-team-foundation/first-tree-hub`) never references this
   package.
2. **Independently deletable.** `scripts/verify-e2e-removable.sh` proves this:
   it stashes `packages/e2e` aside, confirms `pnpm install / typecheck / test
   / build` still pass, and asserts the CLI tarball hash is identical with or
   without the package. Run before every e2e-touching PR merges.
3. **No reverse imports.** Source files under `packages/{server,client,command,
   web,shared}` must never `import "@first-tree-hub/e2e"`. The e2e package
   may only reach the rest of the monorepo via spawned dist binaries or via
   HTTP / WS — never by importing source symbols. (Type-only imports from
   `@agent-team-foundation/first-tree-hub-shared` are fine.)

## Local prerequisites

- Node ≥ 22.16
- pnpm 10.x
- Docker (with `docker compose` v2 preferred; v1 `docker-compose` is the
  fallback)
- Built dist for server + CLI:

  ```bash
  pnpm --filter @first-tree-hub/server build
  pnpm --filter @agent-team-foundation/first-tree-hub build
  ```

## Commands

```bash
pnpm e2e:doctor      # validate env, docker, node, dist presence — no spawn
pnpm e2e:smoke       # M1 smoke run (~30s once dist is warm)
pnpm e2e:up          # boot the env and park it for manual debugging
pnpm e2e:clean       # tear down stale compose projects + prune local logs
```

`pnpm e2e:full` is reserved for M2 and currently aliases the same files as
`smoke`. Distinct CLI surface is in place so CI can wire it up without
follow-up renames.

## macOS note

Docker Desktop's tmpfs is VM-emulated, so the PG boot is noticeably slower
than on Linux native. This is expected. CI runs only on `ubuntu-latest`
(proposal §九 M3 decision).

## Layout

```
packages/e2e/
├── package.json                 # private:true, no publishConfig
├── vitest.config.ts             # globalSetup + fileParallelism:false
├── tsconfig.json
├── .env.e2e.example
├── README.md
├── M0-SPIKE.md                  # findings from the pre-implementation grep pass
├── scripts/
│   ├── compose.e2e.yml          # standalone PG-only compose
│   └── verify-e2e-removable.sh  # §三 removal drill
└── src/
    ├── framework/
    │   ├── env.ts               # .env.e2e loader + zod validation
    │   ├── ports.ts             # get-port + local dedupe
    │   ├── isolation.ts         # runId / home / compose-project derivation
    │   ├── doctor.ts            # docker / node / dist presence checks
    │   ├── docker-pg.ts         # compose up/down + best-effort cleanup
    │   ├── server-process.ts    # spawn server, wait on /healthz
    │   ├── client-process.ts    # spawn `client start --foreground`
    │   ├── readiness.ts         # waitForHttp + sleep utilities
    │   ├── logging.ts           # per-component log files + ring buffer
    │   ├── lifecycle.ts         # full world up/down + exit hooks
    │   ├── current-handle.ts    # tests read serverBaseUrl from disk
    │   └── global-setup.ts      # vitest globalSetup entrypoint
    ├── tests/
    │   └── smoke.e2e.test.ts    # /healthz + /api/v1/health
    └── scripts/
        ├── doctor.ts
        ├── up.ts
        └── clean.ts
```

## Where M2/M3 plug in

- Add the three mocks under `src/framework/mocks/`
  (`agent-handler.ts`, `github.ts`; Feishu is intentionally absent per F4).
- Add new test files as `src/tests/*.e2e.test.ts`; globalSetup already
  provisions the shared world.
- Wire CI in `.github/workflows/e2e-smoke.yml` (M3 — does not exist yet).
