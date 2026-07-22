---
id: session-resume-transient-retry-custody
description: Session resume retries preserve the current inbox delivery as the retry head and drain later work in order.
areas: [runtime]
surfaces: [client, server]
---

# Session resume transient retry custody

Validate session resume retry behavior with an isolated Client, test agent,
and scratch chat whose inbox delivery and ACK state are observable. Establish
a provider session with one notify-worthy message, let its turn finish and its
inbox entry settle, then suspend the session without terminating its persisted
provider session id.

Send a second notify-worthy message and inject a controlled transient failure
before the resumed provider turn accepts that message. A configuration fetch,
transport handshake, or equivalent pre-provider boundary is suitable when it
can fail deterministically without changing provider state. The Runtime must
schedule a bounded session-resume retry and keep the second inbox entry
unacknowledged during backoff.

Allow the retry to proceed and verify from Client logs, handler/provider input,
session events, and inbox settlement that it resumes with the second message's
message id and inbox entry id. It must not replay the first, already-settled
message. The second delivery should complete and ACK without waiting for the
idle timeout or producing an `attempt completion ignored for untracked inbox
entry` warning.

During the retry backoff, send a third notify-worthy message to the same chat.
It must remain behind the second message: the retry uses message two as its
fixed head, injects message three only after the handler is live, and settles
the inbox prefix in the order two then three. No later entry may ACK ahead of
the retry head.

Repeat with message three arriving while the original resume transition is
still pending, before the controlled transient failure is released. The old
handler must not receive that tail. After the resume fails, the replacement
handler must receive message two as its retry head and message three as its
deferred tail, with the same ordered settlement.

Also exercise an explicit control resume with no new user message. Inject the
same transient pre-provider failure and verify the retry calls provider resume
without a message. It must not synthesize an empty user turn or replay the most
recent historical message.

If the environment can safely manipulate Client-local custody, remove the
retry head from the local delivery ledger before the retry attempt. The
Runtime must not create or call a provider handler and must request chat-scoped
inbox recovery instead. The recovered delivery may then proceed through the
normal redelivery path.

Do not report `PASS` unless the exact provider input and inbox entry ids are
observable alongside ACK order and elapsed time. Report `BLOCKED` or
`INCONCLUSIVE` when the transient boundary cannot be controlled or inbox
custody cannot be observed without relying only on unit-test mocks.
