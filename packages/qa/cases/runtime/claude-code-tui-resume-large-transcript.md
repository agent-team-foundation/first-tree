---
id: claude-code-tui-resume-large-transcript
description: Resuming a claude-code-tui session with a large historical transcript starts the tail at EOF instead of synchronously reading and parsing the whole file.
areas: [runtime]
surfaces: [client]
---

# Claude Code TUI resume with a large transcript

Validate that resuming a Claude Code TUI session whose per-session JSONL
transcript already holds a large history does not synchronously read, split,
and parse the entire historical file before the first resumed turn. The
resume tail must initialize at EOF and only consume data appended after the
resume.

Use an isolated test agent on the claude-code-tui provider and a scratch
workspace. Pre-seed or grow a real claude session transcript to a
representative large size (tens of MB of JSONL history, including a long
tool-result entry) through real turns, then suspend the handler so the next
delivery goes through the resume path. Do not hand-craft a transcript at a
path the provider would not write itself; the file must be one claude
actually produced for that workspace and session.

Resume the session with a new inbound message and observe the first resumed
turn end to end. Credible evidence shows the turn's pre-flush completes
without a stall proportional to the historical file size: the first resumed
reply arrives in roughly the same time as an equivalent fresh-session reply,
the Client process does not show a heap spike on the order of the transcript
size, and other agents sharing the Client process remain responsive (their
turns and chat deliveries are not blocked by the resume). Client logs or
tracing that attribute read volume to the transcript tail may support the
conclusion but are not sufficient on their own.

Confirm correctness alongside performance: the resumed turn's reply reflects
only the new delivery and any post-resume transcript entries; no historical
assistant text from before the resume leaks into the resumed turn's
forwarded result. Repeat the resume once more after appending additional
history to confirm the behavior does not regress with growth.

Include a boundary branch: resume a session whose transcript file is missing
or empty (first message never flushed) and confirm the resume still works
and the first real reply is delivered.

Do not report `PASS` when a large real transcript cannot be produced, the
resume path cannot be driven, or responsiveness of co-resident agents cannot
be observed; report `BLOCKED` or `INCONCLUSIVE` with the missing evidence
instead.
