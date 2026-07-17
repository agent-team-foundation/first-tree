---
id: cloud-onboarding-analytics-funnel
description: Validate production GA delivery and the matching server-side onboarding step trail without leaking internal identifiers to GA.
areas: [cross-surface]
surfaces: [server, web]
---

# Cloud Onboarding Analytics Funnel

## Goal

Confirm that the production Cloud SPA sends real GA4 requests for route changes
and the small onboarding event vocabulary, while the existing server event
endpoint retains the authenticated funnel context needed for diagnosis. This
case owns the live browser/provider boundary that deterministic tests cannot
prove; event names, visible-step suppression, and parameter filtering remain
product-test responsibilities.

## Preconditions

- Use a throwaway production account and a disposable campaign URL. Coordinate
  the low-volume production run with the analytics owner so the events can be
  isolated in GA4 DebugView or Realtime without treating ordinary traffic as
  evidence.
- Use a browser profile with analytics blocking disabled. Preserve redacted
  network and server-log evidence; never retain OAuth state, cookies, invite
  tokens, internal user IDs, or organization IDs in shared artifacts.
- Have a connected computer/runtime available so the new-user path can reach a
  first chat. Also use staging or localhost for the production-gate negative
  check; those environments must not contact Google Analytics.

## Operate

1. Enter production Cloud from the disposable campaign URL as a new user and
   complete one normal onboarding path through the first chat.
2. In a second throwaway path, reach a visible setup step, choose "finish
   later", then resume from Settings and continue.
3. Capture the GA script/config exchange and `collect` requests, the matching
   GA4 DebugView or Realtime events, and the corresponding structured
   `onboarding.*` server log lines.
4. Repeat a route change on staging or localhost and confirm that neither the
   GA script nor a `collect` request is emitted.

## Observe

- Production emits one sanitized `page_view` per SPA route transition and GA
  receives `onboarding_step_viewed`, `onboarding_step_completed`,
  `onboarding_step_paused`, and `onboarding_resumed` at the exercised actions.
- Auto-skipped implementation states do not appear as viewed pages. Step events
  carry only low-cardinality context such as `step`, `path`, `nextStep`, and
  `outcome`; GA requests contain no user, member, organization, agent, or chat
  identifiers and no query/hash credentials.
- The server trail contains the same milestones with the authenticated,
  server-controlled user identity and the internal diagnostic context that is
  intentionally excluded from GA. Correlate adjacent asynchronous posts by
  timestamp; their server completion order is not the browser event order.
- The successful path reaches the first-chat completion outcome; pause and
  resume remain distinguishable instead of looking like silent abandonment.
- Staging and localhost produce no GA traffic.

## Expected Result

`PASS` when the browser and GA provider view agree on the exercised visible
path, the server trail contains its diagnostic counterparts, and there is no
duplicate transition event or identifier leak.
`FAIL` for missing production collection, an incorrect event order, a visible
step omission, a skipped-step false positive, sensitive parameters, or any
staging/local GA traffic. `BLOCKED` when production analytics access, a
throwaway account/runtime, or an unblocked browser profile is unavailable.

## Evidence

Keep redacted request names/statuses and parameter keys, GA event timestamps,
the corresponding structured server-event order, and the deployed commit.
Never retain cookies, OAuth material, invite tokens, raw campaign linker values,
or authenticated internal identifiers.
