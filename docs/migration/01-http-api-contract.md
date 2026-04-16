# 01 — HTTP / SSE API Contract

Source of truth: `first-tree-breeze/breeze-runner/src/http.rs` (384 lines) and
the embedded `first-tree-breeze/breeze-runner/src/dashboard.html` (193 lines).
Server is spawned from `service.rs:413-429` (`spawn_http_server`) as part of
`run_forever`. This doc pins the observed behaviour of that server so the TS
port can reproduce it byte-for-byte.

## 1. Listener

- Default bind: `127.0.0.1:7878`. Port is `Config::http_port`
  (`config.rs:136`, default literal `7878` at `config.rs:200, 335`). Overridable
  via `--http-port` / `BREEZE_HTTP_PORT`.
- Loopback only. `http.rs:28-32` explicitly rejects any non-`127.0.0.1` bind
  address with `"refusing to bind http server on non-loopback address ..."`.
  The TS port must preserve this invariant — never bind to `0.0.0.0`.
- Disabled by `--no-http` / `BREEZE_HTTP_DISABLED` (`config.rs:201, 246`). When
  disabled the server thread is not spawned (`service.rs:360-362`).
- Listener is set to non-blocking with a 100 ms poll loop, so shutdown via the
  shared `stop: Arc<AtomicBool>` can exit within ~100 ms (`http.rs:33-62`).
- Each accepted connection is handled on its own thread
  (`http.rs:47-51`). There is no connection pool limit; under load the TS port
  should match this "one task per connection" shape or use Node's `http` server
  with equivalent semantics.
- Per-connection read timeout is 5 s (`http.rs:75`). Stream is switched back to
  blocking mode before reading the request line.
- HTTP parsing is hand-rolled and extremely minimal (`http.rs:116-136`):
  it reads the first line, then drains headers until an empty line. Headers
  themselves are discarded; no `Host`, `Accept`, or `Authorization` parsing.

## 2. Routes

Routing is a simple exact-match after stripping the query string (`http.rs:148-168`).
Only `GET` is accepted; everything else falls through to 404.

| Route                                | Method | Response                    | Notes |
|--------------------------------------|--------|-----------------------------|-------|
| `/`, `/dashboard`, `/index.html`     | GET    | 200 text/html (dashboard)   | Same handler |
| `/healthz`                           | GET    | 200 text/plain `ok\n`       | Liveness probe |
| `/inbox`                             | GET    | 200 application/json passthrough of `~/.breeze/inbox.json` | 404 if file missing |
| `/activity`                          | GET    | 200 application/json array (last 200 lines) | Always 200, empty array if file missing |
| `/events`                            | GET    | 200 text/event-stream (SSE) | Long-lived |
| anything else                        | GET    | 404 text/plain `not found\n`| |
| any non-GET                          | any    | 404 text/plain `not found\n`| Including `POST /inbox` etc. |

Query strings are stripped but otherwise ignored. The unit test
`http.rs:360` asserts `GET /inbox?all=1 HTTP/1.1 → Route::Inbox` — so `?all=1`
on `/inbox` is legal but has no effect.

### 2.1 `GET /` / `/dashboard` / `/index.html`

`write_dashboard` (`http.rs:92-109`):

```
HTTP/1.1 200 OK\r\n
Content-Type: text/html; charset=utf-8\r\n
Content-Length: <len>\r\n
Cache-Control: no-store\r\n
Connection: close\r\n
\r\n
<DASHBOARD_HTML>
```

- `DASHBOARD_HTML` is compiled in via `include_str!("dashboard.html")`
  (`http.rs:90`). The TS port must ship the same HTML file verbatim (or an
  equivalent) and serve it with identical headers.
- Response closes the connection immediately (`Connection: close`).

### 2.2 `GET /healthz`

`write_plain(stream, 200, "ok\n")` (`http.rs:82`, helper at `http.rs:170-185`).
Emits:

```
HTTP/1.1 200 OK\r\n
Content-Type: text/plain; charset=utf-8\r\n
Content-Length: 3\r\n
Cache-Control: no-store\r\n
Connection: close\r\n
\r\n
ok
```

(The trailing newline is part of the body; `Content-Length: 3`.)

### 2.3 `GET /inbox`

Handler: `write_json_file(stream, &inbox_dir.join("inbox.json"))`
(`http.rs:83`, `187-207`).

- If `~/.breeze/inbox.json` exists: reads the file as UTF-8 and streams it back
  unchanged with `Content-Type: application/json; charset=utf-8`.
- If missing: returns 404 with body `inbox.json not found\n` (not JSON).
- The inbox file itself is produced atomically by the fetcher
  (`fetcher.rs:583-598` — write tmp, rename). See doc #2 for the JSON shape.
- No content compression. No streaming — the whole file is buffered into the
  response string.

### 2.4 `GET /activity`

Handler: `write_activity_tail(stream, &inbox_dir.join("activity.log"), 200)`
(`http.rs:84`, `209-249`).

- Reads `~/.breeze/activity.log`, which is JSONL (one JSON object per line).
  See doc #2 for entry schemas.
- Keeps only the **last 200 non-empty lines** (`tail_as_json_array`,
  `http.rs:230-249`).
- Concatenates them into a JSON array by string-joining the lines with commas
  and wrapping in `[...]` — the code does NOT re-parse the JSON. If a line in
  `activity.log` is malformed JSON, the array will be malformed too.
- If the file is missing or unreadable: body is literal `[]` (still 200 OK).
- Response:

```
HTTP/1.1 200 OK\r\n
Content-Type: application/json; charset=utf-8\r\n
Content-Length: <len>\r\n
Cache-Control: no-store\r\n
Connection: close\r\n
\r\n
[{...},{...},...]
```

The 200-line limit is hardcoded. No `?limit=` support today.

### 2.5 `GET /events` (Server-Sent Events)

Handler: `stream_events(stream, bus, stop)` (`http.rs:85`, `252-332`).

Response headers:

```
HTTP/1.1 200 OK\r\n
Content-Type: text/event-stream\r\n
Cache-Control: no-store\r\n
Connection: keep-alive\r\n
X-Accel-Buffering: no\r\n
\r\n
```

(Note: no `Content-Length`; the stream is indefinite.)

Immediately after headers, the server sends a hello frame:

```
event: ready
data: "subscribed"

```

(`http.rs:265`) so the dashboard's `addEventListener("ready", ...)` fires.

After that the server blocks on a bounded `recv_timeout(15 s)` on the in-process
bus (`http.rs:267-287`). There are two event kinds defined in `bus.rs:11-19`:

#### `event: inbox`

Fired whenever the fetcher has finished a poll
(`fetcher.rs:124-129`). Payload (encoded via `Json::Object`, single-line,
deterministic key order):

```
event: inbox
data: {"last_poll":"2026-04-16T20:15:30Z","total":422,"new_count":3}

```

- `last_poll`: ISO-8601 UTC, seconds precision (see `format_utc_iso` in
  `fetcher.rs:690`).
- `total`: `i64` — total notifications in the inbox after this poll.
- `new_count`: `i64` — notifications whose `breeze_status == "new"`.

#### `event: activity`

Fired once per activity log event produced by the fetcher diff
(`fetcher.rs:130-132`). The `data:` payload is the exact JSON line the fetcher
appends to `activity.log`. See doc #2 for those shapes (`new` and `transition`).

```
event: activity
data: {"ts":"2026-04-16T20:15:30Z","event":"new","id":"...","type":"PullRequest","repo":"...","title":"...","url":"..."}

```

Note: `bin/breeze-status-manager` (the shell script) appends additional event
kinds (`claimed`, `transition` with `by`/`reason`) directly to `activity.log`
but it does NOT publish through the bus, so those never flow over SSE. The TS
port should decide whether to unify that (the statusline-manager is a shell
script; see doc #3).

#### Keep-alive

Every 15 s of idle, the server writes a comment line `: ping\n\n`
(`http.rs:282`) to keep intermediate proxies from closing the stream.

#### Disconnect handling

If `write_all` errors with `"Broken pipe"` or `"closed"`, the handler returns
`Ok(())` silently (`http.rs:273-276`). Any other write error propagates.

Each subscriber gets its own `BusReceiver` via `bus.subscribe()`; subscribers
that drop are pruned on the next publish (`bus.rs:41-46`).

## 3. SSE framing

`send_sse` (`http.rs:310-332`):

- Writes `event: <name>\n`.
- For each line of `data`, writes `data: <line>\n`. Multi-line data is emitted
  as multiple `data:` lines.
- If the data ends with `\n`, an empty `data: \n` is also appended (preserving
  the trailing newline per SSE spec).
- Ends with a blank line.
- Flushes after every frame.

## 4. Static assets

Only `dashboard.html` is served. There are **no separate CSS or JS files** —
the dashboard embeds all CSS in `<style>` and all JS in `<script>`
(`dashboard.html:7-67` CSS, `93-190` JS). The TS port does not need a static
file handler; a single HTML blob is sufficient.

The dashboard client makes two outbound requests:
- `fetch("/inbox", { cache: "no-store" })` on load and whenever SSE fires
  (`dashboard.html:149-159, 168-169`).
- `new EventSource("/events")` (`dashboard.html:161-174`).

It never calls `/activity` directly in the shipped dashboard.

## 5. Auth / CORS

**No auth, no CORS headers.** The loopback bind is the only access control.
The TS port must preserve this: no `Access-Control-Allow-Origin`, no cookies,
no tokens. If we bind to `127.0.0.1` we cannot easily expose this dashboard to
other machines without also adding an auth layer. Out of scope for the port.

## 6. Error response format

Every error path uses `write_plain(stream, <code>, <body>)` which returns
`text/plain` with `Cache-Control: no-store` and `Connection: close`. Bodies
observed:

- `404 not found\n` — unknown route or non-GET method
- `404 inbox.json not found\n` — `/inbox` when the file is absent

`reason_phrase` (`http.rs:334-340`) only knows `200 → "OK"` and `404 → "Not
Found"`. Any other code would emit an empty reason — but no other code is used
today.

There is no JSON error envelope and no structured error type. If TS chooses to
add JSON errors, it should do so only on new endpoints.

## 7. Things the Rust server does not do

Recorded here so the TS port doesn't over-engineer:

- No WebSocket — only SSE.
- No HTTP/2, no TLS, no chunked transfer (responses rely on `Content-Length`).
- No request body parsing; all routes are `GET` with no body.
- No partial reads of `inbox.json` — the full file is sent every time.
- No log of HTTP accesses (only errors are printed to stderr).
- No rate limiting, no compression.
- The server shares the process with the poll loop, broker, and runners; there
  is no separate process boundary.

## 8. Unverified / needs TS verification

- **Line 322-324 of `http.rs`** (`data.ends_with('\n')` branch) emits a spurious
  trailing empty `data: \n` followed by the frame-terminating blank line. This
  is subtle and it is unclear whether existing JS consumers rely on it. Phase 3
  should capture a sample raw SSE stream with `curl -N http://127.0.0.1:7878/events`
  and diff against the TS output byte-for-byte.
- The dashboard's `new EventSource` auto-reconnects on error
  (`dashboard.html:170-173`). The Rust server does not hint `retry:`. The TS
  server should match (omit `retry:`) unless we deliberately add reconnect
  tuning.
