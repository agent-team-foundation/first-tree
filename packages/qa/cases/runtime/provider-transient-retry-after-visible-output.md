---
id: provider-transient-retry-after-visible-output
description: Transient provider failures remain retryable after a turn has emitted visible output or tool effects.
areas: [runtime]
surfaces: [client, server]
---

# Provider transient retry after visible output

Validate that a Codex turn which has already produced assistant output or a
tool effect remains recoverable when the provider then reports an explicit
transient capacity or transport failure. The Runtime should route the owned
delivery through retry/recovery rather than consuming it as an
`unsafe_replay` terminal failure.

Use an isolated test agent and scratch workspace. The provider or bridge must
be controllable enough to produce a completed, reversible scratch-file change
followed by either the exact capacity message `Selected model is at capacity.
Please try a different model.` or a clear transient transport failure. Do not
induce failures against a production provider account and do not use external
or irreversible tool effects merely to satisfy this case.

Observe the turn's session events, Client logs, chat messages, and inbox
settlement closely enough to establish the sequence. Credible evidence shows
that the visible/tool event precedes the provider failure, the failure enters
the bounded retry path without an immediate terminal runtime notice or ACK,
and resumed agent execution can inspect the already-changed scratch state and
finish the delivery.

Also hold the same transient failure through the full retry budget. Produce the
visible scratch-file effect only on the first attempt, then fail the next two
attempts before they emit new output. The first two failures should schedule
foreground retries; the third should emit `provider_retry_exhausted`. Its
durable runtime notice must be posted before the original delivery is
acknowledged exactly once. No fourth provider attempt or recovery redelivery
should occur.

During the first retry backoff, inject a second message into the same chat. It
must remain queued until the original delivery's retry turn has started; it
must not start a competing turn during the backoff. After the retry turn
starts, normal steer/drain processing may attach the queued tail.

Repeat with the second message successfully steered into the first attempt
before that attempt fails. Every later retry attempt and the final success or
exhausted settlement must retain both messages. The steered tail must not be
left in processing state or separately retried.

Include a negative branch when the controlled environment supports it: a
credential, deterministic-input, or unknown-custody failure must still stop
instead of being treated as a known transient retry. Do not report `PASS` when
the provider failure cannot be induced deterministically or the inbox
settlement is not observable; report `BLOCKED` or `INCONCLUSIVE` with the
missing evidence instead.
