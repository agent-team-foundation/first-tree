---
id: claude-code-tui-large-transcript-resume
description: Verify a real Claude Code TUI session resumes from a large transcript without rereading or parsing historical records and still consumes only new appends.
areas: [runtime]
surfaces: [client, cli, server]
---

# Claude Code TUI Large-Transcript Resume

## Goal

Confirm that a real `claude-code-tui` session resumed through First Tree establishes its transcript baseline at the
current EOF without the Client reading, splitting, or parsing historical JSONL, then processes transcript bytes appended
by the resumed Claude turn in order and exactly once.

This is a live provider/tmux integration and performance case. Pair it with `runtime-provider-readiness`. Stable
semantics such as the 64 KiB read ceiling, fixed per-drain watermark, partial and UTF-8 boundaries, the 8 MiB incomplete
record limit, oversize recovery, suspend-fence interleavings, and I/O-failure settlement remain product-test
responsibilities. This case checks that those mechanics survive the real Client → tmux → Claude Code → transcript
boundary.

## Preconditions

- Reach `QA READY` with the complete isolated First Tree harness before selecting this case. Use a run-local Client home,
  agent workspace, server data, tmux socket/state, and disposable chat; never use an operator checkout, production chat,
  or another live Client's tmux sessions.
- Run the candidate Client through an explicit native/provider bridge when the TUI cannot credibly run in Docker. The
  bridge must still use isolated First Tree state and a unique client identity.
- Install a real on-disk `claude` executable and `tmux` on the Client host. The SDK-bundled Claude binary is not sufficient
  for `claude-code-tui`.
- Establish Claude `one-turn-ready` under the same OS user that runs the Client: the TUI can launch, pass its interactive
  readiness gates, and complete an authenticated turn. Reuse host-local provider authentication without reading,
  copying, or archiving credential contents.
- Create a disposable agent configured for `claude-code-tui`, complete an initial real turn, and record the persisted
  Claude session id, agent cwd, exact transcript path, and owning Client PID.
- Prepare a large, complete, provider-accepted JSONL history while the handler is suspended. Prefer history produced by a
  disposable real session or a sanitized fixture verified by a control resume. Record logical and allocated size, line
  count, hash, and EOF. Do not use sparse holes or NUL padding as the sole workload: an invalid provider transcript would
  confound Client tail behavior with Claude resume failure.
- Choose the large-history size in the run-local plan and record why it is material on that host. When practical, retain
  equivalent small-history and large-history reset points for comparison.
- Have a host observer that can attribute file metadata operations and content reads to the First Tree Client PID,
  including path, offset, requested length, returned length, and time. Separately identify Claude and tmux child PIDs so
  their transcript access is not charged to the Client. Also sample Client-only RSS and one benign operation serviced by
  the same event loop, such as runtime heartbeat handling or another run-local control probe.
- If the environment cannot distinguish the Client's transcript reads from the provider's reads, wall-clock timing alone
  is not enough for `PASS`.

## Checklist

First suspend the real session through the public session-control path and confirm the owned tmux pane is gone while the
session id remains resumable. Grow the transcript only while the handler is stopped, preserve a recognizable historical
sentinel in the disposable data, and start the Client file/process observer before resuming.

Exercise an administrative resume with no message using the public CLI/API session-control path. Keep inbound input
quiescent until the session is reported active and the Client records the resume as complete. During this phase:

- metadata-only inspection of the transcript is allowed;
- the Client must perform zero content reads from the transcript;
- no historical transcript entry or sentinel may be emitted as a new First Tree session event or chat result;
- Client RSS must not show a transient allocation comparable to the historical transcript size;
- the concurrent Client-owned responsiveness probe must continue to make progress.

After the no-message resume completes, record the transcript's current EOF again because Claude may have appended
provider-owned startup or summary data. Send a fresh message containing a unique run nonce and ask for a short
nonce-bearing response. For this turn, define `baseline` as the exact EOF established by the metadata-only discard before
tmux paste, not the earlier administrative-resume observation. Observe the transcript, Client session events, chat
result, and inbox settlement through turn completion. After paste, the Client may issue one 1-byte read at
`baseline - 1` to determine whether the discarded EOF ended on LF; this byte must never be parsed or emitted. Every other
content read must begin at or after `baseline`, no other read may revisit historical bytes, and every request—including
the probe—must be no larger than 64 KiB. The new assistant output must be forwarded once, in transcript order, without
replaying the historical sentinel.

Also exercise the ordinary messageful-resume path from a clean reset point: suspend again, append another block of valid
historical JSONL, start observation, and send a new message directly to the suspended chat instead of issuing an
administrative resume first. Capture enough process evidence to order the metadata-only EOF baseline before the tmux
paste operation. Before that paste, the Client must not content-read the transcript. After the paste, only newly appended
bytes may be consumed and the delivery must settle exactly once.

Characterize, rather than hide, performance. Record the history workload, resume phase boundaries, Client transcript
bytes requested/returned, peak Client RSS, responsiveness-probe latency, and provider-ready/turn-complete durations. If a
small/large pair is available, compare the Client measurements. The primary oracles are zero pre-paste content I/O and
zero historical record parsing or replay. After paste, the sole permitted historical I/O is one optional 1-byte
LF-boundary probe at the pre-paste `baseline - 1`. Timing is supporting evidence because Claude itself may read or
summarize its history during `--resume`.

## Expected Result

`PASS` requires a real authenticated tmux/Claude session and attributable evidence that both no-message and messageful
resume establish an EOF baseline without pre-paste Client content reads, do not replay historical entries, preserve
Client event-loop progress, and process a later valid append in order and exactly once through chat delivery and inbox
settlement. Apart from the optional post-paste 1-byte LF-boundary probe at `baseline - 1`, all Client transcript reads
are at most 64 KiB and start in the newly appended region.

`FAIL` means a reproducible candidate defect, including the Client reading pre-baseline transcript content beyond the
single allowed LF-boundary byte, reading that byte before paste, allocating memory proportional to the historical file
while baselining, emitting historical entries as current-turn output, reading an unbounded chunk, pasting before the
resume baseline is established, losing or duplicating the new result, or blocking other Client event-loop work in
proportion to historical size.

`BLOCKED` means the real Claude executable, tmux, authentication, account/network capacity, provider-accepted transcript
fixture, or isolated native bridge is unavailable. Claude independently rejecting or failing to resume the prepared
history is an environment/fixture blocker unless the same history resumes successfully outside the candidate Client.

`INCONCLUSIVE` means the turn ran but transcript I/O could not be attributed to Client versus Claude, phase ordering
could not be recovered, or only wall-clock/RSS observations are available without the content-read evidence.

## Evidence

Keep the target ref and artifact identities; OS, filesystem, Claude, tmux, Node, and First Tree versions; sanitized
session/cwd/transcript identifiers; history logical and allocated sizes, line count, hash, and baseline offsets; the
Client-only file-I/O trace; process tree and tmux session identity; Client RSS and responsiveness samples; session event
and inbox-settlement sequence; nonce-bearing result; and cleanup confirmation.

Do not retain raw private transcript content, prompts, credentials, tokens, keychain material, or tmux paste buffers.
Hashes, byte ranges, event kinds, redacted markers, and aggregate syscall tables are normally sufficient.

## Limitations

This case covers the current append-only transcript contract. It does not validate truncation, inode replacement, or
rotation. It also does not claim that Claude Code's own `--resume` work is independent of history size; provider-process
CPU, memory, and transcript reads must be reported separately from the First Tree Client.

Bounded transcript ingestion does not make the whole turn constant-memory: accumulated valid assistant output can still
grow `finalTexts`. Exact chunk, line-limit, malformed-line, UTF-8, deadline, abort, and injected-I/O-failure behavior
belongs in Vitest and must not be inferred from this live case.
