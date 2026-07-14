---
id: github-webhook-routing-regression
description: Verify a signed GitHub App webhook still reaches the expected followed chat and agent wake path after SCM processing changes.
areas: [cross-surface]
surfaces: [server, github, client]
---

# GitHub Webhook Routing Regression

## Goal

Verify the live GitHub App ingress-to-chat path across its real boundaries: HMAC authentication, installation-to-Team
resolution, normalized event processing, followed-chat routing, card persistence, and inbox wake delivery. Product tests
own deterministic payload and failure matrices; this case checks that the assembled deployment still wires those parts
together without a GitHub-specific post-delivery branch.

## Preconditions

- Use an isolated Docker plus temporary-worktree QA run cell.
- Configure a GitHub App webhook secret and a bound, active installation for the test Team. Use a disposable repository
  and test identities; do not point a production App at the run cell.
- Create a chat with an eligible human/delegate pair and follow one disposable issue or pull request in that chat.
- Keep a matching client runtime connected if the plan includes observing the agent wake. A missing provider credential
  may block the later model turn, but it must not prevent card and inbox evidence.

## Operate and Observe

- Deliver a valid HMAC-signed webhook for the followed entity with a stable `X-GitHub-Delivery` value. Observe one GitHub
  card in the followed chat and, for an explicit target, the expected delegate inbox/session wake.
- Redeliver the same signed body with the same stable delivery id. Observe a successful deduplicated response and no
  second card or wake.
- Deliver an equivalent supported event without `X-GitHub-Delivery`. Confirm it is accepted without creating a
  `processed_events` claim. If the event is repeated, treat repeated side effects as the documented weak-reliability
  baseline rather than an exactly-once promise.
- Send a request with an invalid signature and confirm it is rejected before installation lookup, claim, card, or wake.
- If Context Reviewer is enabled for the Team, include one supported Context Tree PR trigger and confirm it still reuses
  its dedicated reviewer chat while remaining covered by the same whole-request claim.

## Expected Result

`PASS`: signed events resolve through the bound installation, reach the expected chat and wake path, stable delivery ids
deduplicate the whole request, missing delivery ids do not claim, invalid signatures have no side effects, and optional
Context Reviewer behavior remains dedicated and claim-covered.

`FAIL`: a reproducible regression in authentication, tenant resolution, followed-chat/card delivery, wake routing,
whole-request deduplication, or Context Reviewer claim coverage.

`BLOCKED`: the isolated run cell cannot provision a disposable App/installation, webhook credential, bound entity, or
connected runtime needed by the selected observations.

`INCONCLUSIVE`: only internal logs or database state are available and the user-visible card/inbox behavior cannot be
attributed to the tested ref.

## Evidence

Keep redacted request/response records, the followed-chat card, relevant inbox/session evidence, and the duplicate and
invalid-signature outcomes. Never retain the webhook secret, access tokens, or full signed request headers.
