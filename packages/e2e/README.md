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

## What ships today

| Milestone | What it adds | Tests |
| --- | --- | --- |
| **M1** | doctor + env validation, per-run isolated PG via `docker compose` (tmpfs, random port), spawned `server` + `client --foreground`, smoke against `/healthz` + `/api/v1/health`. | `smoke.e2e.test.ts` |
| **M2** | `github-mock` (signs + delivers webhooks, stubs outbound `/api/*`), human-agent credentials helper (`framework/credentials.ts`), `ws-listener.ts` for `agent:ws` frames, real `chat-send` over HTTP. | `messaging`, `github-webhook`, `agent-runtime` |
| **M2.5** | GitHub PR → chat delivery (server self-creates chat + mapping), PG NOTIFY → server WS push → `inbox:deliver` frame on a parallel client. | `github-pr-delivery`, `ws-inbox-push` |

Feishu coverage stays in-process per F4 — there is no Feishu e2e mock.

The framework is **deliberately not wired into CI yet** — it needs more
soak time on real development branches before it can gate PRs. Devs run
`pnpm e2e:smoke` / `E2E_WITH_CLIENT=1 pnpm e2e:full` locally as part of
e2e-touching PR review; once the suite has stabilized over a few weeks of
real-world runs the CI wiring (proposal §九 M3) will land separately.

## Hard rules

1. **Not published.** `private: true`. Cache isolation comes from turbo's
   default per-package hashing — each task hashes only its own package's
   files, so edits inside `packages/e2e` cannot bust the build / typecheck /
   test cache of any other package. `turbo.json` additionally pins this
   intent via explicit `"inputs": ["$TURBO_DEFAULT$"]` on those tasks (the
   visual-guard form of proposal §三.4; the cross-package `!packages/e2e/**`
   glob the proposal mentions is package-local in turbo 2 semantics and a
   no-op, but the per-package default already gives the same isolation).
   The published CLI tarball (`@agent-team-foundation/first-tree-hub`) never
   references this package.
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
pnpm e2e:smoke       # smoke run only (~10s once dist is warm; no client spawn)
pnpm e2e:full        # every *.e2e.test.ts file (~10s on cold cache)
pnpm e2e:up          # boot the env and park it for manual debugging
pnpm e2e:clean       # tear down stale compose projects + prune local logs
```

`e2e:full` requires `E2E_WITH_CLIENT=1` for the messaging /
github-pr-delivery / agent-runtime / ws-inbox-push suites — globalSetup
gates the spawned CLI + credentials provisioning on that env var so the
smoke run stays cheap. Run the full suite with:

```bash
E2E_WITH_CLIENT=1 pnpm e2e:full
# or, from packages/e2e:
E2E_WITH_CLIENT=1 pnpm vitest run
```

## macOS note

Docker Desktop's tmpfs is VM-emulated, so the PG boot is noticeably slower
than on Linux native. This is expected and only matters during local
iteration; when CI wiring lands it will be `ubuntu-latest`-only (proposal
§九 M3).

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
│   └── verify-e2e-removable.sh  # §三 removal drill
└── src/
    ├── framework/
    │   ├── env.ts               # .env.e2e loader + zod validation
    │   ├── ports.ts             # get-port + local dedupe
    │   ├── isolation.ts         # runId / home / compose-project derivation
    │   ├── doctor.ts            # docker / node / dist presence checks
    │   ├── docker-pg.ts         # `docker run` PG + best-effort cleanup
    │   ├── server-process.ts    # spawn server, wait on /healthz
    │   ├── client-process.ts    # spawn `client start --foreground`
    │   ├── setup-devuser.ts     # M5 dev-user seed: dev-callback → connect-token → CLI client start → agent/chat/message (driven from up.ts, not tests)
    │   ├── readiness.ts         # waitForHttp + sleep utilities
    │   ├── logging.ts           # per-component log files + ring buffer
    │   ├── lifecycle.ts         # full world up/down + exit hooks + pre-teardown hooks
    │   ├── current-handle.ts    # tests read serverBaseUrl from disk
    │   ├── credentials.ts       # M5 fixture: single-user PG seed for tests (paired with setup-devuser.ts above; one is the fixture, the other is the live-seed)
    │   ├── github-mock.ts       # M2: signs + delivers webhooks, stubs /api/*
    │   ├── github-app-fixture.ts# M2: GitHub App key + installation token fixture
    │   ├── agent-mock.ts        # M2: stand-in for the agent runtime side
    │   ├── ws-listener.ts       # M2: agent:ws client + frame waiter
    │   ├── db-migrate.ts        # apply drizzle migrations against the run's PG
    │   └── global-setup.ts      # vitest globalSetup entrypoint
    ├── tests/
    │   ├── smoke.e2e.test.ts          # /healthz + /api/v1/health
    │   ├── messaging.e2e.test.ts      # chat-send + replyTo over HTTP
    │   ├── github-webhook.e2e.test.ts # inbound webhook → PG side-effects
    │   ├── github-pr-delivery.e2e.test.ts # PR event → chat + mapping
    │   ├── ws-inbox-push.e2e.test.ts  # PG NOTIFY → inbox:deliver WS frame
    │   └── agent-runtime.e2e.test.ts  # client spawn → agent bind smoke
    ├── mocks/
    │   └── fake-claude-code.mjs # offline replacement for @anthropic-ai/claude-agent-sdk
    └── scripts/
        ├── doctor.ts
        ├── up.ts
        └── clean.ts
```

## Writing a new e2e test

`globalSetup` already provisions the shared world (PG + server + optional
spawned CLI), dumps the handle to `.e2e-runs/current.json`, and tears
everything down at the end of the vitest run. A new test boils down to:

1. Drop a file under `src/tests/<name>.e2e.test.ts`.
2. `readCurrentHandle()` to get `serverBaseUrl`, `databaseUrl`,
   `githubWebhookSecret`, `clientHome`, and (when `E2E_WITH_CLIENT=1`)
   provisioned `credentials`.
3. Drive the system through HTTP / WS / `github-mock` — never by importing
   server source (see "No reverse imports" above).

Pick the closest existing test as the template:

| When the new test… | Reference template |
| --- | --- |
| only hits public HTTP routes as a logged-in human | `messaging.e2e.test.ts` |
| drives an inbound GitHub webhook and asserts PG side-effects | `github-webhook.e2e.test.ts` |
| needs the github-mock to also stub outbound `api.github.com` calls | `github-pr-delivery.e2e.test.ts` |
| spawns a parallel WS client and waits for server pushes | `ws-inbox-push.e2e.test.ts` |
| boots an agent runtime / chat session smoke path | `agent-runtime.e2e.test.ts` |
| only needs `/healthz` / `/api/v1/health` style ping | `smoke.e2e.test.ts` |

### Driving a webhook

```ts
import { startGithubMock } from "../framework/github-mock.js";
import { readCurrentHandle } from "../framework/current-handle.js";

const handle = readCurrentHandle();
const mock = await startGithubMock({
  serverBaseUrl: handle.serverBaseUrl,
  webhookSecret: handle.githubWebhookSecret,
});

// Signed delivery → POST /api/v1/webhooks/github-app on the real server.
const { status, body, deliveryId } = await mock.emit("installation", {
  action: "created",
  installation: { id: 42, account: { login: "acme", type: "Organization", id: 7 } },
});
```

For the **outbound** half (server reaches `api.github.com`), register a
fastify route on `mock.fastify` **before** the action triggers the call —
the mock returns 404 by default, and the 404 body explicitly tells you
which path the test should stub. See
`github-pr-delivery.e2e.test.ts` for installation-access-token + REST
endpoint stubs.

### Listening on WS

```ts
import { connectWsListener } from "../framework/ws-listener.js";

const listener = await connectWsListener({
  serverBaseUrl: handle.serverBaseUrl,
  accessToken: creds.accessToken,
  clientId,                     // must already exist in `clients` table
  bindAgents: [{ agentId, runtimeType: "claude-code" }],
});

const frame = await listener.waitFor(
  (f) => f.type === "inbox:deliver" && f.chatId === chatId,
  3_000,
);
```

Open a **parallel** client (`clientId` distinct from the spawned CLI's
own `creds.clientId`) when you need to assert server pushes without
disturbing the long-running spawned client — registering a second WS
with the same `clientId` evicts the first.

### Direct PG vs public API

Default to the **public HTTP API**. The whole point of the e2e package
is to exercise the same validation, authz, and event-emission paths a
real caller would hit (`POST /agents` runs `R-RUN` parsing, name regex,
manager-in-org checks, etc.).

Reach into PG with `new PgClient({ connectionString: handle.databaseUrl })`
only when:

- You need to **seed** a row the API intentionally doesn't let users
  create directly (e.g. a fresh entry in `clients` for a parallel WS
  listener — see `ws-inbox-push.e2e.test.ts` and the same pattern in
  `framework/credentials.ts`).
- You need to **assert a side-effect** that isn't observable through the
  API surface yet (e.g. confirming `github_app_installations` upserted
  after a webhook landed — `github-webhook.e2e.test.ts`).
- You're verifying NOTIFY/LISTEN plumbing where the API only exposes the
  push, not the row that produced it.

If a row can be created or read through the API, prefer that — direct
PG writes silently bypass the server-side invariants you most want
covered, and a future schema change can drift PG-vs-API behaviour
without breaking the test.

## Removability drill — local-only for now

Run `bash packages/e2e/scripts/verify-e2e-removable.sh` from the repo
root before merging any PR that touches `packages/e2e/**`. The drill
stashes the package aside, confirms `pnpm install / typecheck / test /
build` still pass without it, and asserts the published CLI tarball
hash is byte-identical with and without `packages/e2e`. Paste the final
hash line into your PR body as evidence — until the suite earns its way
into CI, this is the only contract that guarantees the package stays
independently deletable.
