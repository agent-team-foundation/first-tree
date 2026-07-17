---
id: cloud-onboarding-analytics-funnel
description: Validate campaign attribution, OAuth continuity, production GA delivery, and the matching server-side onboarding trail without leaking internal identifiers to GA.
areas: [cross-surface]
surfaces: [server, web]
---

# Cloud Onboarding Analytics Funnel

## Goal

Confirm that one tagged acquisition remains observable through the website,
OAuth, Cloud onboarding, and first chat. The production Cloud SPA must send real
GA4 requests for route changes, anonymous auth attempts/results, and the small
onboarding event vocabulary, while the server retains the authenticated funnel
context needed for diagnosis. This case owns the live browser/provider boundary
that deterministic tests cannot prove; event names, visible-step suppression,
and parameter filtering remain product-test responsibilities.

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
- In GA4 property `539170414`, register the event-scoped custom dimensions used
  for reporting before the run: `form_id`, `scan_attempt_id`, `variant`,
  `auth_attempt_id`, `provider`, `result`, `entry_point`, `join_path`,
  `account_type`, `reason_code`, `step`, `path`, `nextStep`, `reasonCode`,
  `retryable`, and `outcome`. Mark `start_scan`, `sign_up`, and
  `onboarding_kickoff_chat_started` as key events. Confirm downstream
  campaign-export readers accept schema version 2. Standard GA traffic-source
  dimensions own UTM attribution; do not duplicate them as custom dimensions.

## Operate

1. In a clean profile, enter an ordinary tagged production website URL and use
   the primary Cloud CTA. Confirm the decorated `_gl` handoff is consumed and
   the Cloud GA client/session retains the original UTM source, medium,
   campaign, and content through OAuth and onboarding.
2. In a second clean profile, enter the tagged production-scan page, submit the
   campaign form, continue through OAuth, and complete Cloud onboarding through
   the first chat. Keep only the anonymous attempt IDs needed for the
   reconciliation.
3. Exercise one controlled OAuth failure (for example cancel/expired state),
   then retry successfully. Confirm the retry creates a new auth attempt.
4. In a separate throwaway path, reach a visible setup step, choose "finish
   later", then resume from Settings and continue.
5. Exercise one safe, user-visible onboarding failure and retry, such as a
   connect-token mint failure in a controlled environment or a runtime that
   does not become ready before the timeout.
6. Capture the GA script/config exchange and `collect` requests, the matching
   GA4 DebugView or Realtime events, and the corresponding structured
   `oauth.*` / `onboarding.*` server log lines. Reconcile the campaign attempt
   with the schema-v2 Campaign export and its action-conversion fields.
7. Repeat a route change on staging or localhost and confirm that neither the
   GA script nor a `collect` request is emitted.

## Observe

- The pre-OAuth `auth_started` and post-OAuth `auth_result` carry the same
  anonymous `auth_attempt_id`, provider, and low-cardinality entry point. The
  failed attempt has a fixed `reason_code`; the successful new-account result
  has `account_type=created` and emits `sign_up` exactly once at account
  creation, not again when onboarding completes.
- Production emits one sanitized `page_view` per SPA route transition and GA
  receives `onboarding_step_viewed`, `onboarding_step_completed`,
  `onboarding_step_failed`, `onboarding_step_paused`, and `onboarding_resumed`
  at the exercised actions.
- Auto-skipped implementation states do not appear as viewed pages. Step events
  carry only low-cardinality context such as `step`, `path`, `nextStep`,
  `outcome`, `reasonCode`, and `retryable`; GA requests contain no user, member,
  organization, agent, chat, repo, raw error, URL query, or hash credentials.
- The server trail contains the same milestones with the authenticated,
  server-controlled user identity and the internal diagnostic context that is
  intentionally excluded from GA. Correlate adjacent asynchronous posts by
  timestamp; their server completion order is not the browser event order.
- The successful path reaches the first-chat completion outcome; pause and
  resume remain distinguishable instead of looking like silent abandonment.
- The ordinary CTA path remains one GA user/session with its original standard
  traffic-source dimensions before and after the cross-domain and OAuth hops.
- The Website scan attempt, Cloud auth attempt/result, first chat, Campaign
  export row, and action conversion reconcile without relying on a raw user ID.
- Staging and localhost produce no GA traffic.

## Expected Result

`PASS` when the browser and GA provider view agree on acquisition, auth, the
exercised visible path, and classified failure; the server/export trail contains
its diagnostic counterparts; registered dimensions are queryable; and there is
no duplicate transition event or identifier leak.
`FAIL` for missing production collection, an incorrect event order, a visible
step omission, a skipped-step false positive, sensitive parameters, or any
staging/local GA traffic. `BLOCKED` when production analytics access, a
throwaway account/runtime, or an unblocked browser profile is unavailable.

## Evidence

Keep redacted request names/statuses and parameter keys, GA event timestamps,
the corresponding structured server-event order, and the deployed commit.
Never retain cookies, OAuth material, invite tokens, raw campaign linker values,
or authenticated internal identifiers.
