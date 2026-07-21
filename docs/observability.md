# Observability

first-tree ships a vendor-neutral observability stack built on pino
(logs) and OpenTelemetry (traces). Tracing is **off by default** — configure
an OTLP endpoint to enable it.

## Quick start

### Logs only (default, zero config)

No setup required. The server emits structured logs to stdout in a
human-readable format during development, and as NDJSON in production
(`NODE_ENV=production`).

### Logs + traces

Configure an OTLP/HTTP endpoint and matching headers — any backend that
speaks OTLP works (Logfire, Honeycomb, Jaeger, Tempo, SigNoz, Axiom, …).

```yaml
# server.yaml (SaaS internal — typically injected as env vars in production)
observability:
  tracing:
    endpoint: https://<your-otlp-endpoint>/v1/traces
    headers:
      Authorization: "Bearer <write-token>"
    serviceName: first-tree
    environment: production
    sampleRate: 1.0
```

Or via environment variables (preferred for secret tokens):

```bash
FIRST_TREE_OTEL_ENDPOINT=https://<your-otlp-endpoint>/v1/traces
FIRST_TREE_OTEL_HEADERS="Authorization=Bearer <write-token>"
```

Restart the server. You should see `tracing enabled: exporter=otlp-http ...`
in the startup log.

## Configuration reference

| Path | Env var | Default | Notes |
|---|---|---|---|
| `observability.logging.level` | `FIRST_TREE_LOG_LEVEL` | `info` | `trace` / `debug` / `info` / `warn` / `error` / `fatal` |
| `observability.logging.format` | — | `pretty` (dev), `json` (prod) | Pretty for humans, JSON for log collectors |
| `observability.logging.bridgeToSpanLevel` | — | `error` | Minimum pino level whose records are attached to the active span. `warn` / `error` / `off` |
| `observability.tracing.endpoint` | `FIRST_TREE_OTEL_ENDPOINT` | `""` (disabled) | OTLP/HTTP traces URL |
| `observability.tracing.headers` | `FIRST_TREE_OTEL_HEADERS` | `""` | `key1=val1,key2=val2` format |
| `observability.tracing.exporter` | — | `otlp-http` | `otlp-http` or `otlp-grpc` |
| `observability.tracing.serviceName` | — | `first-tree` | Shown in trace backends |
| `observability.tracing.environment` | — | `development` | `deployment.environment.name` OTel attr |
| `observability.tracing.sampleRate` | — | `1.0` | `0.0–1.0`, ratio applied at root |

## Sentry error monitoring

First Tree uses Sentry for product-side error monitoring on the Web Console
and local Client runtime. These are separate Sentry projects because the Web
Console is a hosted browser surface while the Client daemon runs on
operator-owned machines.

| Surface | Sentry project | Default behavior | Disable path |
|---|---|---|---|
| Web Console | `first-tree-web` | Enabled when `VITE_SENTRY_DSN` is configured in the web build. | Omit `VITE_SENTRY_DSN` or set `VITE_SENTRY_ENABLED=false` for local/dev builds. |
| Client daemon/runtime | `first-tree-client` | Enabled when `FIRST_TREE_CLIENT_SENTRY_DSN` is configured. | Set `FIRST_TREE_CLIENT_SENTRY_ENABLED=false`. |

Both surfaces tag events with the git SHA used to build the artifact:

- Web reads `FIRST_TREE_WEB_BUILD_ID` at build time, falling back to `git rev-parse HEAD`.
- Client reads the git SHA baked into the published CLI package, or
  `FIRST_TREE_GIT_SHA`, `FIRST_TREE_CLIENT_GIT_SHA`, or `GITHUB_SHA` when an
  operator override is needed.

### Web configuration

```bash
VITE_SENTRY_DSN=https://public@example.ingest.sentry.io/1
VITE_SENTRY_ENABLED=true
VITE_SENTRY_ENVIRONMENT=production
VITE_SENTRY_TRACES_SAMPLE_RATE=0.1
FIRST_TREE_WEB_BUILD_ID=$GITHUB_SHA
```

`VITE_SENTRY_ENABLED` is a build-time switch. Omit it to enable Web Sentry when
a DSN exists, or set it to `false` to disable browser initialization even when
the build environment still supplies a DSN. The Web build emits a sanitized
browser security manifest from the same activation decision. An enabled Sentry
entry contains only the DSN origin—never its public key, project path, query, or
the raw DSN—and the deployed server must include that exact origin in
`FIRST_TREE_CSP_CONNECT_ORIGINS`. A missing or different origin fails embedded
SPA startup instead of shipping a policy that silently blocks telemetry.

The Vite build generates hidden source maps and uploads them through
`@sentry/vite-plugin` when `SENTRY_AUTH_TOKEN` and `SENTRY_ORG` are present.
The upload target defaults to `first-tree-web`; override with
`SENTRY_PROJECT_WEB` only for a temporary diagnostic build. Missing upload
credentials or upload failures emit warnings and do not fail the deployable
artifact.

The Docker release workflow passes `VITE_SENTRY_DSN`,
`VITE_SENTRY_ENABLED`, and `VITE_SENTRY_ENVIRONMENT` from GitHub
repository/environment variables into the Web build. This keeps activation,
the generated candidate manifest, and the runtime CSP preflight aligned without
committing the public DSN to the repo. Source-map upload credentials remain a
separate build concern and do not enable the browser SDK.

### Client configuration

```bash
FIRST_TREE_CLIENT_SENTRY_DSN=https://public@example.ingest.sentry.io/2
FIRST_TREE_CLIENT_SENTRY_ENVIRONMENT=production
FIRST_TREE_CLIENT_SENTRY_ENABLED=true
FIRST_TREE_GIT_SHA=$GITHUB_SHA
```

The npm publish workflow bakes `FIRST_TREE_CLIENT_SENTRY_DSN` from GitHub
repository/environment variables into the published CLI package. Local operator
env still wins at runtime, so a machine can override the DSN or set
`FIRST_TREE_CLIENT_SENTRY_ENABLED=false` to disable Client events explicitly.
For background services, put `FIRST_TREE_CLIENT_SENTRY_*` overrides in the
user-owned `daemon.env` file under `FIRST_TREE_HOME`. The daemon loads that file
before Sentry initialization, so the operator's choice survives daemon restarts
without baking observability settings into the launchd/systemd unit.

The Client scrubber drops user identity, request bodies, cookies, query
strings, breadcrumbs, bearer tokens, OAuth/token-like fields, and local home /
workspace path prefixes before sending events. Runtime content fields such as
provider prompts, model output, tool output, stdout, and stderr are redacted.

## Web product analytics and session insights

The Web Console loads Microsoft Clarity for production session insights. The
project id is `xj2f9syfng`.

Clarity is loaded by the Web analytics bootstrap only when the browser is on
the production Cloud hostname. Local development and staging hosts do not fetch
the Clarity SDK or write into the production project. The same checked-in
browser resource registry drives this hostname activation and the sanitized
candidate security manifest; deployment documentation must not maintain a
second vendor-origin list.

The Web Console treats Clarity as layout/session telemetry, not content
telemetry. The React root (`#root`) carries `data-clarity-mask="true"` so chat
messages, agent traces, connect commands, tokens, repo paths, and other
customer/workspace text rendered by the app are masked before upload. Do not add
`data-clarity-unmask` inside the app unless the surface is public/static and the
privacy boundary has been reviewed with the exact content classes it can render.

## Multi-environment setup (one backend, many environments)

A common deployment pattern is to point **all** environments (dev, staging,
prod, …) at the **same** Logfire / Honeycomb / … project, and rely on the
UI's filter/group features to tell them apart. The server supports this
out of the box — no need to maintain multiple projects or tokens.

### How it works

Every span the server emits carries three OTel resource attributes that trace
backends treat as first-class:

| Attribute | Value | Configured by |
|---|---|---|
| `service.name` | `first-tree` (customizable) | `observability.tracing.serviceName` |
| `deployment.environment.name` | `development` / `staging` / `production` / … | `observability.tracing.environment` or `FIRST_TREE_OTEL_ENVIRONMENT` |
| `service.instance.id` | `srv_<8-char-hex>` — unique per process | auto-generated at startup |

### Typical deployment

The SaaS Docker image runs `node packages/server/dist/index.mjs`; pass the
OTLP env vars to the container (e.g. via the platform's secrets store):

```bash
docker run \
  -e FIRST_TREE_OTEL_ENDPOINT=https://logfire-us.pydantic.dev/v1/traces \
  -e FIRST_TREE_OTEL_HEADERS="Authorization=Bearer <token>" \
  -e FIRST_TREE_OTEL_ENVIRONMENT=production \
  -e FIRST_TREE_DATABASE_URL=... \
  ghcr.io/agent-team-foundation/first-tree:latest
```

Swap `production` → `staging` for the staging instance; same token, different
env label.

### Filtering in the UI

- **Logfire**: top filter bar → add `deployment.environment.name = production`
- **Honeycomb**: dataset filter `deployment.environment.name = production`
- **Jaeger / Tempo**: search → Tags → `deployment.environment.name=production`
- **SigNoz / Axiom**: resource attribute filter with the same key

### When to use separate projects instead

One project-per-environment is only necessary if:

- **Strict data isolation is required** (e.g. prod data must never commingle
  with dev for compliance) — then use distinct tokens per environment and
  rotate them independently.
- **Retention policies differ** per environment — some backends apply
  retention at the project level.
- **Cost attribution** needs to be per environment — most backends bill
  per-project.

Otherwise, a single project with `deployment.environment.name` filtering is
simpler to operate and makes cross-environment comparisons trivial.

### Multi-replica deployment

When you scale out to multiple server instances behind a load balancer, each
process gets its own `service.instance.id` at startup. To drill into a
specific replica in your trace backend, filter by that attribute — this is
how you answer "which replica is spiking latency" without manual tagging.

## Log message conventions

All runtime logs — server *and* client — go through the same pino pipeline
with the same pretty/json formats. To keep grep-ability and structured-
search working across a growing codebase, follow these five rules when
adding new log lines.

### 1. English, lowercase, no trailing punctuation

```ts
// ✅
log.error({ err }, "failed to reload config");
log.info({ count }, "cleaned up stale sessions");

// ❌
log.error({ err }, "Failed to reload config.");
log.info("CLEANUP DONE!");
```

### 2. Errors: `"failed to <verb> <object>"` form

One shape for error messages makes skimming faster.

```ts
// ✅
log.error({ err, entryId }, "failed to deliver inbox entry");

// ❌
log.error({ err }, "delivery failed");
log.error({ err }, "inbox entry delivery error");
```

### 3. Info: past tense describing what happened

```ts
// ✅
log.info({ agentId }, "bound agent");
log.info({ count }, "marked agents as stale");

// ❌
log.info({ agentId }, "binding agent...");
log.info({ agentId }, "agent will be bound");
```

### 4. Context goes in the attrs object, not interpolated into the message

```ts
// ✅  — structured, grep / Loki-filterable
log.warn({ entryId, retries }, "retry budget exhausted");

// ❌  — a needle in a haystack at scale
log.warn(`entry ${entryId} gave up after ${retries} retries`);
```

Rule of thumb: if a downstream consumer (Loki / Datadog / a human running
`grep`) might want to filter by a value, it belongs in attrs.

### 5. Don't repeat the module name in the message

The `[Module]` prefix is emitted automatically by the pretty formatter.

```ts
const log = createLogger("Inbox");

// ✅  output:  INFO  [Inbox] entry expired
log.info({ entryId }, "entry expired");

// ❌  output:  INFO  [Inbox] inbox: entry expired
log.info({ entryId }, "inbox: entry expired");
```

### What these rules do NOT cover

- **CLI status output** (`first-tree` connect / client banners,
  `status(...)` helpers) is a different channel — it's interactive,
  user-facing, and can use formatting / localized strings. It does *not*
  go through pino.
- **Existing log lines that predate these rules**. Follow the style when
  you touch a file; don't do bulk rewrites purely for style.
- **Natural exceptions**: acronyms stay capitalized (`"failed to parse JWT"`),
  proper nouns stay capitalized (`"connected to Logfire"`).

## Backend cheat sheet

Values below go into `observability.tracing.endpoint` / `.headers`.

### Logfire (Pydantic)

```
endpoint: https://logfire-us.pydantic.dev/v1/traces   # or logfire-eu.*
headers:
  Authorization: "Bearer pylf_v1_us_xxxxxxxxxxxx"
```

Get a write token at Logfire → Settings → Write Tokens.

### Honeycomb

```
endpoint: https://api.honeycomb.io:443/v1/traces
headers:
  x-honeycomb-team: "<ingest-key>"
```

### Jaeger (OTLP-enabled ≥1.35)

```
endpoint: http://<jaeger-host>:4318/v1/traces
```

### Grafana Tempo / Cloud

```
endpoint: https://tempo-us-central1.grafana.net/tempo/v1/traces
headers:
  Authorization: "Basic <base64(user:token)>"
```

### Axiom

```
endpoint: https://api.axiom.co/v1/traces
headers:
  Authorization: "Bearer <api-token>"
  x-axiom-dataset: "<dataset-name>"
```

## Troubleshooting recipes

### "Find the full story of one user message"

Every delivery path stamps the same attribute set. Search in your trace
backend for any of:

- `inbox.entry.id = "<id>"` — single inbox entry, enqueue → deliver → ack
- `message.id = "<id>"` — one business message across chats / fan-outs
- `chat.id = "<id>"` — every span on a given chat
- `agent.id = "<id>"` — all spans touching a specific agent

### "Why did agent X disconnect?"

Search `ws.connection` spans filtered by `client.id = "<id>"`. The span's
duration shows connection lifetime; `ws.close.code` attribute shows the
reason the socket closed.

### "Correlate an error from logs to trace"

Error responses return a `x-trace-id` header and include `traceId` in the
body. Copy it into your trace backend to jump straight to the full tree.

### "Turn on temporarily"

Inject the env vars when launching the SaaS server container:

```
docker run \
  -e FIRST_TREE_LOG_LEVEL=debug \
  -e FIRST_TREE_OTEL_ENDPOINT=https://... \
  -e FIRST_TREE_OTEL_HEADERS="Authorization=Bearer ..." \
  ghcr.io/agent-team-foundation/first-tree:latest
```

## Sampling guidance

| Deployment | Sample rate | Rationale |
|---|---|---|
| Local dev | `1.0` | Full trace on every request, fast feedback |
| Staging | `1.0` | Rare enough traffic that full sample is cheap |
| Prod, low-traffic (<10 req/s) | `1.0` | Still cheap at this volume |
| Prod, medium-traffic | `0.1`–`0.25` | Representative sample without overwhelming the backend |
| Prod, high-traffic (>100 req/s) | `0.01`–`0.05` | Cap backend cost; relies on tail-based or attribute-biased sampling at the backend for error-path coverage |

Sampling is `ParentBased(TraceIdRatioBased(sampleRate))` — inbound
`traceparent` headers from upstream services are respected.

## Known limitations

- **WebSocket traces appear "Incomplete" while connected.** Our `ws.connection`
  span is deliberately long-running (lives for the full socket lifetime),
  so Logfire and other trace UIs will show it as "Incomplete" or "missing
  root span" *until the client disconnects*. This is expected — the span
  finalizes with attributes like `ws.close.code` once the socket closes.
  For short-lived per-message visibility, search by `ws.message.type` or
  the `client.id` / `agent.id` attributes directly.
- **Orphan spans at async boundaries.** When a message is enqueued and
  delivered in different async roots (later tick, different WS connection),
  the deliver span is a new trace root rather than a child of the original
  request. Use attribute-based search (see "Find the full story" above).
  Fixing this requires persisting W3C `traceparent` on inbox rows and is
  tracked as tech debt until multi-replica deployment makes it necessary.
- **No client-side tracing.** Client (`@first-tree/client`) emits logs
  only. Agent-side work is observed indirectly via server-side spans
  (`ws.connection`, `ws.message`, inbox attrs).
- **No PG span.** PostgreSQL queries are not wrapped in spans — for query
  performance investigation, PostgreSQL's own `log_min_duration_statement` +
  `pg_stat_statements` is typically sufficient. If cross-query correlation
  becomes a need, this should be reconsidered as a dedicated feature, not a
  flag-gated default.
- **Server restart loses in-flight trace context.** Messages enqueued but
  not yet delivered keep their business state but lose the original
  request's trace linkage. Attribute search still works.
