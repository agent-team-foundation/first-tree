# M0 spike report — `feature/e2e-framework-m0`

Date: 2026-05-18
Author: yzw-assistant (driven by yuezengwu)
Scope: re-verify proposal v4 findings against `main` source before scaffolding M1.

This report covers the **code-level** spike — does the integration surface look the way the proposal assumes? Runtime spike of LLM interception (M0.2 three-track) is **deferred to M2** because M1 smoke deliberately avoids the agent runtime (proposal §九). Each track gets its own spike note when M2 starts.

---

## F1 — `client start --foreground` already exists

`packages/command/src/commands/client.ts:85`:

```ts
.option("--foreground", "Run inline instead of delegating to the background service (for debugging)")
```

The handler treats `options.foreground === true || isSupervisorChild` as the inline branch (`wantInline`) and bypasses the systemd/launchd installation paths entirely. `--foreground` plus `--no-interactive` is what the e2e framework needs.

**Status**: ✅ no client source change required. Framework spawns CLI via `node packages/command/dist/cli/index.mjs client start --foreground --no-interactive`.

## F2 — `/healthz` is the right liveness probe (not `/health`)

`packages/server/src/api/healthz.ts:10`:

```ts
app.get("/healthz", { config: { rateLimit: false } }, async (_request, reply) => { … });
```

Registered at the **root** of the fastify instance (`app.ts:418` — outside the `/api/v1` scope), and explicitly opts out of rate-limit. `/api/v1/health` exists too and returns `{status: "ok", db: "connected"}` but routes through the rate-limit + auth middleware chain.

**Status**: ✅ `server-process.ts` polls `/healthz` for readiness with `consecutive: 3`. Smoke test additionally asserts `/api/v1/health` returns the structured payload.

## F3 — GitHub API URL was hardcoded; new module reads env

Old state (5 sites in `services/github-app.ts`, 1 site in `services/github-oauth.ts`, 1 const in `services/github-entity-live.ts`): all bare `https://api.github.com/...`. No env override path.

New state (this branch): centralised in `services/github-api-base.ts`:

```ts
export const GITHUB_API_BASE = normalize(process.env.FIRST_TREE_HUB_GITHUB_API_BASE_URL);
```

Defaults to `https://api.github.com`, strips trailing `/`. All three service files now interpolate `${GITHUB_API_BASE}/...`.

**Status**: ✅ implemented under M0.3 in this same commit. Existing in-process tests (`__tests__/github-app*.test.ts`) still pass because the default is identical to the literal they assert against. Independently useful for GHE / mirrored deployments.

## F4 — Lark SDK has no endpoint override → feishu-mock is OUT of scope

Confirmed via inspecting `@larksuiteoapi/node-sdk` usage in `services/adapter-manager.ts`: `new Client({ appId, appSecret })` and `new WSClient({...})` constructors don't accept `domain` / `baseUrl`. Combined with the documented SDK quirk of ignoring `NO_PROXY`, every interception path (mitmproxy, monkey-patch, SDK fork) is too brittle for an "always-on" framework.

**Status**: ✅ M2 plan honours this — no `feishu-mock` will be added. Feishu coverage stays where it is: `packages/server/src/__tests__/feishu-adapter.test.ts` + staging. Blind-spot is recorded in proposal §十一.5.

## F5 — readiness probe uses `/healthz` (M1) not admin/clients

The proposal v4 suggested `GET /api/v1/admin/clients` to confirm the client actually connected. Grep shows **no such endpoint** — owner-facing surfaces are `/api/v1/me/clients` (user-JWT-gated) and `/api/v1/orgs/:orgId/clients` (org-admin-gated). Both require auth that the M1 smoke run hasn't yet provisioned.

**Decision**: M1 smoke only asserts that `client` survived startup (1.5s grace + non-exit). Proving the WS handshake lands at the very front of M2 once we mint a test user JWT and hit `/api/v1/me/clients` to read `agentCount` / `status: "online"`.

**Status**: ✅ documented; tracked as M2 entry condition.

## F6 — GitHub App env vars all carry `FIRST_TREE_HUB_GITHUB_APP_*` prefix

`packages/server/src/boot-guards.ts:44–48`:

```ts
FIRST_TREE_HUB_GITHUB_APP_ID, FIRST_TREE_HUB_GITHUB_APP_CLIENT_ID,
FIRST_TREE_HUB_GITHUB_APP_CLIENT_SECRET, FIRST_TREE_HUB_GITHUB_APP_PRIVATE_KEY,
FIRST_TREE_HUB_GITHUB_APP_WEBHOOK_SECRET
```

Same mapping in `packages/shared/src/config/server-config.ts:105–116`.

**Status**: ✅ noted for M2 github-mock env injection.

## F7 — webhook path is `/api/v1/webhooks/github-app`

`packages/server/src/app.ts:425–426` registers `githubAppWebhookRoutes` with prefix `/webhooks` inside the `/api/v1` scope. Final path is `/api/v1/webhooks/github-app`. No legacy `/webhooks/github/:orgId` path exists today.

**Status**: ✅ noted for M2 github-mock driver.

## G1 — `claudeCodeExecutable` is the agent-mock injection point

`packages/client/src/handlers/claude-code.ts:331`:

```ts
const claudeCodeExecutable =
  (config.claudeCodeExecutable as string | undefined) ?? resolveClaudeCodeExecutable().path;
```

`packages/client/src/handlers/claude-executable.ts:29` resolves it from the `CLAUDE_CODE_EXECUTABLE` env var (or PATH lookup, or SDK-bundled fallback). The agent-mock can point this at a fake node binary in M2 — zero client source change required.

**Note**: the proposal referenced `FIRST_TREE_HUB_CLAUDE_CODE_EXECUTABLE`. The real env var is plain `CLAUDE_CODE_EXECUTABLE`. `client-process.ts` injects under the correct name.

**Status**: ✅ injection point confirmed; M2 will deliver the fake binary + JSONL protocol stub.

---

## Net change to proposal

| Proposal claim | Actual | Action |
|---|---|---|
| M0.1 verify `--foreground` | Exists at `commands/client.ts:85` | Used as-is |
| M0.3 add `FIRST_TREE_HUB_GITHUB_API_BASE_URL` (~15 lines) | Implemented (`github-api-base.ts` + 7 call sites) | Done in this PR |
| Agent injection env var name `FIRST_TREE_HUB_CLAUDE_CODE_EXECUTABLE` | Real name is `CLAUDE_CODE_EXECUTABLE` | Corrected in `client-process.ts`; flag back to proposal for v5 errata |
| Readiness probe via `GET /api/v1/admin/clients` | Endpoint doesn't exist | M1 uses `/healthz` only; admin/clients-style probe deferred to M2 |
| Three-track LLM interception spike runtime validation | Not exercised in M1 (agent runtime not driven) | Deferred to M2 entry condition |

No proposal-breaking finding. M1 proceeds.
