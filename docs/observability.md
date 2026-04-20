# Observability

First Tree Hub ships a vendor-neutral observability stack built on pino
(logs) and OpenTelemetry (traces). Tracing is **off by default** — configure
an OTLP endpoint to enable it.

## Quick start

### Logs only (default, zero config)

No setup required. Hub emits structured logs to stdout in a human-readable
format during development, and as NDJSON in production (`NODE_ENV=production`).

### Logs + traces

Configure an OTLP/HTTP endpoint and matching headers — any backend that
speaks OTLP works (Logfire, Honeycomb, Jaeger, Tempo, SigNoz, Axiom, …).

```yaml
# ~/.first-tree-hub/config/server.yaml
observability:
  tracing:
    endpoint: https://<your-otlp-endpoint>/v1/traces
    headers:
      Authorization: "Bearer <write-token>"
    serviceName: first-tree-hub
    environment: production
    sampleRate: 1.0
```

Or via environment variables (preferred for secret tokens):

```bash
FIRST_TREE_HUB_OTEL_ENDPOINT=https://<your-otlp-endpoint>/v1/traces
FIRST_TREE_HUB_OTEL_HEADERS="Authorization=Bearer <write-token>"
```

Restart the server. You should see `tracing enabled: exporter=otlp-http ...`
in the startup log.

## Configuration reference

| Path | Env var | Default | Notes |
|---|---|---|---|
| `observability.logging.level` | `FIRST_TREE_HUB_LOG_LEVEL` | `info` | `trace` / `debug` / `info` / `warn` / `error` / `fatal` |
| `observability.logging.format` | — | `pretty` (dev), `json` (prod) | Pretty for humans, JSON for log collectors |
| `observability.logging.bridgeToSpanLevel` | — | `error` | Minimum pino level whose records are attached to the active span. `warn` / `error` / `off` |
| `observability.tracing.endpoint` | `FIRST_TREE_HUB_OTEL_ENDPOINT` | `""` (disabled) | OTLP/HTTP traces URL |
| `observability.tracing.headers` | `FIRST_TREE_HUB_OTEL_HEADERS` | `""` | `key1=val1,key2=val2` format |
| `observability.tracing.exporter` | — | `otlp-http` | `otlp-http` or `otlp-grpc` |
| `observability.tracing.serviceName` | — | `first-tree-hub` | Shown in trace backends |
| `observability.tracing.environment` | — | `development` | `deployment.environment.name` OTel attr |
| `observability.tracing.sampleRate` | — | `1.0` | `0.0–1.0`, ratio applied at root |
| `observability.tracing.captureContent` | `FIRST_TREE_HUB_OTEL_CAPTURE_CONTENT` | `false` | Include message bodies / prompts in span attrs. **Opt-in** for privacy |
| `observability.tracing.instrumentPostgres` | — | `false` | Wrap postgres queries with spans. Opt-in |

## Multi-environment setup (one backend, many environments)

A common deployment pattern is to point **all** environments (dev, staging,
prod, …) at the **same** Logfire / Honeycomb / … project, and rely on the
UI's filter/group features to tell them apart. Hub supports this out of the
box — no need to maintain multiple projects or tokens.

### How it works

Every span Hub emits carries three OTel resource attributes that trace
backends treat as first-class:

| Attribute | Value | Configured by |
|---|---|---|
| `service.name` | `first-tree-hub` (customizable) | `observability.tracing.serviceName` |
| `deployment.environment.name` | `development` / `staging` / `production` / … | `observability.tracing.environment` or `FIRST_TREE_HUB_OTEL_ENVIRONMENT` |
| `service.instance.id` | `srv_<8-char-hex>` — unique per process | auto-generated at startup |

### Typical deployment

```bash
# Production instance
FIRST_TREE_HUB_OTEL_ENDPOINT=https://logfire-us.pydantic.dev/v1/traces \
FIRST_TREE_HUB_OTEL_HEADERS="Authorization=Bearer <token>" \
FIRST_TREE_HUB_OTEL_ENVIRONMENT=production \
  first-tree-hub server start

# Staging instance (same token, different env label)
FIRST_TREE_HUB_OTEL_ENDPOINT=https://logfire-us.pydantic.dev/v1/traces \
FIRST_TREE_HUB_OTEL_HEADERS="Authorization=Bearer <token>" \
FIRST_TREE_HUB_OTEL_ENVIRONMENT=staging \
  first-tree-hub server start
```

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

When you scale out to multiple Hub instances behind a load balancer, each
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
log.error({ err }, "failed to reload adapter");
log.info({ count }, "cleaned up stale sessions");

// ❌
log.error({ err }, "Failed to reload adapter.");
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

- **CLI status output** (`first-tree-hub server start` banner, `status(...)`
  helpers) is a different channel — it's interactive, user-facing, and can
  use formatting / localized strings. It does *not* go through pino.
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

### SigNoz self-hosted

```
endpoint: http://<signoz-host>:4318/v1/traces
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

```
FIRST_TREE_HUB_LOG_LEVEL=debug \
FIRST_TREE_HUB_OTEL_ENDPOINT=https://... \
FIRST_TREE_HUB_OTEL_HEADERS="Authorization=Bearer ..." \
  first-tree-hub server start
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
- **No client-side tracing.** Client (`@first-tree-hub/client`) emits logs
  only. Agent-side work is observed indirectly via Hub-side spans
  (`ws.connection`, `ws.message`, inbox attrs).
- **No PG span by default.** PostgreSQL query spans are opt-in via
  `observability.tracing.instrumentPostgres: true`. For query performance
  investigation, PostgreSQL's own `log_min_duration_statement` +
  `pg_stat_statements` is usually sufficient.
- **Server restart loses in-flight trace context.** Messages enqueued but
  not yet delivered keep their business state but lose the original
  request's trace linkage. Attribute search still works.
