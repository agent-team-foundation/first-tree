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

Repeat the pending-resume setup, but suspend the chat before releasing the
provider boundary and then let the old resume succeed. The old route must not
be adopted: it must not replace the persisted session id, accept the deferred
tail, settle inbox work, report retry success, or reclaim an active slot.
Explicit resume must first request chat-scoped recovery, and recovered entries
must be accepted exactly once by a fresh handler.

Exercise the same late-success boundary under the configured concurrency
limit. While the resume is pending, let fresh work in another chat make the
target yield its slot and start inbox recovery. Redeliver the target head and
tail while the old provider promise is still unresolved, then release the old
promise. Only the replacement handler may accept the ordered head and tail,
and observed live provider routes must never exceed the configured
concurrency.

During a retry attempt, suspend the chat while provider resume is pending and
then let that attempt succeed late. There must be no
`provider_retry_succeeded` event, retry-state clearing on behalf of the stale
attempt, stale session-id adoption, or route revival. Recovery debt and slot
accounting must remain attributable to the suspend decision.

Repeat cancellation while the chat's first provider `start()` is still
unresolved and no resumable session id has been adopted. After recovery,
redeliver the same head and a later tail. The replacement handler must receive
the head through `start()`, never `resume()`, then accept the tail in order;
the canceled start must not leave an empty resume mapping or settle either
delivery.

Before releasing that unresolved start, have it report
`processingStarted`, then issue operator suspend and hold its terminal-prefix
ACK open. Deliver a same-chat tail while that ACK is pending. The
unestablished SessionEntry must remain as an admission fence until suspend
preparation settles: no replacement start, resume, or inject may enter the
provider during the ACK window.

Evict the same unestablished chat while it is in a non-active fresh-start
retry/terminal window, and separately restart the SessionManager while its
first start is unresolved. Neither LRU state nor the persisted registry may
contain an empty resume mapping. Historical empty mappings must be ignored on
load, and every recovered delivery must enter the replacement handler through
`start()`.

After a route is fully active, capture a delivery token from an injected
message, suspend or preempt the route, recover the chat, and redeliver the
same inbox entry id. Every late mutation through the old token must be ignored:
it must not mark the replacement ledger as processing, settle it, request
another retry, or terminal-reject it. Only the fresh route may settle and ACK
the redelivery.

Also hold a provider resume before it materializes its provider resource,
invalidate the route, and allow the first best-effort cleanup to finish. When
the stale resume later succeeds and creates that resource, a post-settlement
cleanup pass must close it. Separately, defer an active handler's terminate
cleanup and deliver another message for the same chat during that wait. Local
admission must already be closed: the terminating handler must not receive the
message or run outside its released slot, and terminate recovery must retain
custody of the new entry.

Repeat terminate while a new chat delivery is still blocked in pre-handler
configuration or Context Tree resolution, before any local SessionEntry
exists. Terminate must still cancel that admission and recover the ledger
entry; releasing the blocked preflight must not start a provider route or
claim an active slot.

Repeat the same blocked pre-handler admission while shutting down the entire
SessionManager. Releasing the preflight after shutdown returns must not create
a handler, session, or active slot; the admitted inbox entry must remain
recoverable by the next manager lifecycle.

Also begin a messageful resume while the target session is still waiting for
an earlier suspension or recovery operation. Start manager shutdown and hold it
open with a second active handler's slow cleanup, then release the resume wait.
The shutdown tombstone must prevent handler creation, provider resume, and slot
claiming; the inbox head must remain recoverable for the next manager lifecycle.

For normal resume, eviction resume, and retry resume, inject a messageful
handler result with a session id but no route receipt. Each path must fail
closed with `missing_route_receipt`, retain the head for recovery, and avoid
draining any tail. The retry path must not report
`provider_retry_succeeded`. A message-less control resume remains the only
path where a null route receipt is valid.

On an otherwise healthy active route, make `inject()` capture its delivery
token and then reject or throw before accepting custody. Recover and redeliver
the same inbox entry id without changing the session generation, then invoke
every mutation on the old token. The replacement ledger, recovery debt, and
ACK prefix must remain unchanged until the winning attempt settles.

Hold a confirmed session-event callback across suspend, recovery, and
redelivery, then let the old callback finish after the winning route has stored
its own failure notice. The stale callback must not overwrite the winning
payload. Repeat with the old delivery blocked while posting its runtime failure
notice: completion of that post must neither clear the winning payload nor
settle the replacement ledger.

For a terminal resume failure, hold confirmation while terminate or manager
shutdown invalidates the route and waits on slow handler cleanup. Resolve the
confirmation before cleanup completes. A callback that can no longer adopt its
runtime notice must not authorize terminal ACK; the head must stay covered by
recovery debt.

Finally, queue two later messages behind a retry head and make the handler
reject or throw on the first tail while it would accept the second. The Runtime
must stop immediately: the second tail must not reach the provider, the
already-terminal prefix may ACK, and the rejected tail plus untouched suffix
must enter chat-scoped recovery without an ACK-prefix inversion.

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
observable alongside ACK order, transition timing, active-slot counts, and
elapsed time. Report `BLOCKED` or `INCONCLUSIVE` when suspend or concurrency
yield cannot be interleaved with a controlled late provider success, or when
inbox custody cannot be observed without relying only on unit-test mocks.
