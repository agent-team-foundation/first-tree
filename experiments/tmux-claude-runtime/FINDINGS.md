# tmux-claude-runtime — design rationale & verification matrix

The `claude-code-tui` handler
(`packages/client/src/handlers/claude-code-tui/`) drives the **interactive**
`claude` CLI inside a tmux pane instead of speaking the Agent SDK's
stream-json protocol. This document is the design rationale its header
comments cite, plus the contract↔verification matrix the
`@first-tree/e2e` TUI suite (`packages/e2e/src/tests/tui-*.e2e.test.ts`)
exercises.

> History: the original proof-of-concept code that produced these findings was
> a throwaway spike and was not preserved. This document was reconstructed
> from the merged handler and is kept in sync with it by the e2e suite — every
> contract below has an executable scenario, so drift surfaces as a red test
> rather than a stale doc.

---

## Why tmux at all

The SDK path (`claude-code` handler) talks to a headless `claude` over
stdin/stdout stream-json. The TUI path exists for the post-SDK-sunset world
where the only supported entry point is the interactive `claude` binary. That
binary expects a terminal: it paints a live UI, reads keystrokes, and writes
its authoritative event stream to a per-session transcript file. tmux gives us
a real PTY we can drive headlessly — inject input via `paste-buffer`, observe
state via `capture-pane`, and read results from the transcript.

So the handler observes **two surfaces** and the contract between them is the
thing under test:

1. **Pane text** (`capture-pane -p`) — coarse state: is a turn in flight, is
   the CLI ready. Matched against the magic strings in `tui-markers.ts`.
2. **Transcript JSONL** (`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`)
   — the authoritative event stream: assistant text and tool calls. This is
   what gets forwarded to chat, never the pane scrape.

The fake (`packages/e2e/src/mocks/fake-claude-tui.mjs`) reproduces both
surfaces so the handler's real logic runs unmodified against it.

---

## Pane markers (the magic strings)

| Marker | String | Meaning |
| --- | --- | --- |
| `READY_MARKER` | `bypass permissions on` | CLI booted; `waitForReady` also needs a `❯` prompt line |
| `WORKING_MARKER` | `esc to interrupt` | a turn is in flight; its **disappearance** is the turn-end signal |
| `USER_RE` | `^❯ ` (NBSP) | prompt line; the trailing glyph is U+00A0, not ASCII space |

Two non-obvious facts the fake must honour (both learned the hard way and now
pinned by the e2e suite):

- **The working marker is a live status line, not scrollback.** Real `claude`
  *erases* `esc to interrupt` when the turn completes. A fake that prints it
  once and leaves it in the pane makes `pane.includes(WORKING_MARKER)` true
  forever, so the handler waits out the full `TURN_TIMEOUT_MS`. The fake clears
  the screen (`\x1b[2J\x1b[3J\x1b[H`) on each state transition so the marker
  actually goes away at idle.
- **The prompt uses a NBSP.** `capture-pane` trims trailing ASCII spaces, so a
  `❯ ` painted with a normal space loses the space and `USER_RE` (`^❯[\s ]`)
  fails to match — `waitForReady` then times out. Paint U+00A0.

---

## Input injection

The runtime injects `[From: <name>]\n<body>`-shaped messages. tmux delivers
them via `load-buffer` + `paste-buffer -p` (bracketed paste) + a separate
`send-keys Enter`. Two requirements:

- **Bracketed paste must be enabled** (`\x1b[?2004h`). Without it `paste-buffer
  -p` ships the bytes verbatim and the newline *inside* the message is mistaken
  for the terminating Enter — only the first line is read. The fake enables
  DECSET 2004 at startup and parses a `\x1b[200~ … \x1b[201~` block as a single
  unit.
- **Buffer hygiene matters for confidentiality.** The tmux buffer lives on the
  shared tmux *server*, not in the session, so it survives the session being
  killed and is readable via `tmux show-buffer` from any other session. The
  handler deletes it (`paste-buffer -d` + a `delete-buffer` backstop) and
  removes the temp dir, not just the file.

---

## Session naming (collision-resistant, client-scoped)

`deriveSessionName(clientId, agentId, chatId)` →
`ftth-<clientTag>-<digest>`:

- `clientTag` = last 8 chars of the sanitized client id. Scopes every session
  to the owning client process so the orphan sweep and session names never
  collide with another live client / parallel QA slot on the shared tmux
  server.
- `digest` = **`SHA-256(`agentId` + NUL + `chatId`)` sliced to 12 hex**. The
  separator is a literal `\0`, NOT a space. A 48-bit slice of uniform entropy
  avoids the uuidv7 prefix-collision that a truncated-id name would suffer (two
  agents created in the same millisecond share leading chars). Hex-only output
  is inherently tmux-safe.

> Test mirrors must replicate the NUL separator byte-for-byte
> (`runtime-tui-fixture.ts:expectedTuiSessionName`). A space silently yields a
> different digest — `tui-tmux-lifecycle` guards this by asserting the live
> session name equals the helper's output.

---

## Turn disposition (the reliability core)

`resolveTurnDisposition({ aborted, timedOut, turnFailed, forwardFailed })`
decides three observable outcomes — `turn_end` status, whether to `ack` the
inbox entries, and whether to `forward` assistant text to chat. The
reliability-critical rule (PR #712 review round 3):

- A **timed-out** turn is NOT a success. `claude` was interrupted before
  reaching idle, so the work is unconfirmed. Acking it would silently consume
  the user's message with no replay path. So a timeout reports
  `turn_end: error`, withholds the ack (server redelivers on reconnect/restart
  for a genuine retry), withholds the forward (a partial drain must NOT
  double-post once the replay produces the real answer), and settles the
  runtime into `error`.
- An **abort** (suspend) likewise withholds ack + forward so the message
  re-runs on resume, but stays a non-error status (deliberate, not a failure).
- A clean close acks even on a forward-only failure (mirrors the SDK handler's
  `ackTurnClose`, avoiding redelivery storms).

---

## AskUserQuestion is disabled at spawn

The tmux runtime can't navigate `claude`'s selection menu — there is no human
at the pane. The handler prevents the menu from ever appearing: it launches
`claude` with `--disallowed-tools AskUserQuestion`, stripping the tool from
the model's context entirely. `--dangerously-skip-permissions` bypasses the
permission layer, so a permissions-based deny is not an option here.

> History: an earlier design kept the tool enabled and *degraded* each
> invocation — detect the `Enter to select` menu footer, send `Escape`, format
> the cancelled `tool_use` input as markdown, and forward it as a plain-text
> round trip. That path (and its `ASKUSER_MENU_FOOTER` marker) was removed
> end-to-end in PR #747; `tui-askuser-disallowed` pins the current contract.

---

## Orphan sweep

On the first handler instantiation per process, sessions left over from a
prior crashed run of **this client** are killed — scoped by the
`ftth-<clientTag>-` prefix, never the bare `ftth-`. Multiple client processes
(prod / staging / dev) and parallel QA slots share one tmux server, so a
blanket sweep would tear down a live peer's pane.

---

## Verification matrix — contract ↔ scenario

| Contract | e2e scenario |
| --- | --- |
| Capability probe reports `claude-code-tui: ok` (claude + tmux + auth) | `tui-capability-probe` |
| Happy turn: inject → drain transcript → forward → ack | `tui-runtime-basic` |
| `tool_use`/`tool_result` flow through the shared processor to `session_events` | `tui-runtime-tool-call` |
| Spawn argv disables AskUserQuestion via `--disallowed-tools` (degrade path removed in PR #747) | `tui-askuser-disallowed` |
| Session name = `deriveSessionName` (NUL digest); paste buffer cleaned up | `tui-tmux-lifecycle` |
| Orphan sweep kills owned `ftth-<tag>-*`, leaves foreign sessions | `tui-orphan-sweep` |
| Mid-turn daemon death → un-acked → redelivered + completed on restart | `tui-restart-resume` |
| Fake crash mid-session surfaces an error (no silent ack) | `tui-crash-recovery` |

Run the whole matrix: `pnpm --filter @first-tree/e2e e2e:tui`.
Hand-drive a live TUI agent: `pnpm --filter @first-tree/e2e e2e:tui:bootstrap`.
