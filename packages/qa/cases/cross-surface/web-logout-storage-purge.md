---
id: web-logout-storage-purge
description: Validate that signing out of the web app (explicit logout, 401 auto-logout, or OAuth account adoption) leaves no readable chat, image, draft, or account-scoped metadata in browser storage, and that another account on the same profile cannot see the departed account's data.
areas: [cross-surface]
surfaces: [web, server]
---

# Web Logout Storage Purge

## Goal

Confirm that browser-side storage never outlives the account that produced it
on a shared browser profile: every sign-out path purges the IndexedDB caches
and account-scoped localStorage, database names are namespaced per account so
a second account can never open the first account's data, and the
deliberately-kept preferences survive.

## Operate

Use two disposable accounts (A and B) in one normal, non-incognito browser
profile. As A: open chats until timelines hydrate from cache, send or view
images, leave an unsent draft in a composer, and scroll so read positions
persist. Inspect storage (DevTools Application panel or equivalent) and record
the pre-logout baseline: database names and `first-tree:*` localStorage keys.

Exercise all three departure paths, re-seeding A's data before each:

1. Explicit logout from the user menu; also smoke the mobile Me screen
   sign-out.
2. Automatic logout: invalidate A's session server-side (expire or revoke the
   refresh token) and let a background request run into a 401.
3. Account adoption without logout: while A is signed in, complete B's OAuth
   flow in the same tab so the app adopts B's tokens directly.

After each path, inspect storage again; on path 3 also verify that B's
freshly-created databases survive the purge of A's. Then work as B in the same
chats A used. Finally sign back in as A once to confirm caches refill from the
server. Repeat one explicit logout with a second signed-in tab open on the app.

## Observe

- After explicit and 401 logout: no `first-tree-*` IndexedDB database remains
  (including the legacy un-namespaced names); `first-tree:chat-drafts:v1`,
  `first-tree:new-chat-default-agent:*`, and both `first-tree:chat-summary-*`
  key families are gone; `first-tree:tokens` is gone.
- Deliberate survivors stay: `first-tree:selectedOrganizationId:<userId>` and
  pure UI preferences such as `theme` — signing back in as A lands on A's
  previously selected organization.
- While A is signed in, database names end in `:u:<A's user id>`; after B
  signs in they end in B's id, and B's timelines, images, read positions, and
  composers show none of A's content.
- On the adoption path, A's databases and account-scoped keys are purged while
  B's newly-created databases survive.
- Logout completes promptly (no hang) even with the second tab open; the
  second tab ends signed out, with storage purged after its next request.
- The browser console shows no unhandled rejections from cache reads or
  writes racing the purge at sign-out time.
- An unsent composer draft is gone after every path — the accepted UX cost of
  the guarantee, worth confirming rather than assuming.

## Expected Result

`PASS` when every departure path leaves no chat, image, draft, or
account-metadata residue readable in the profile, B sees none of A's data, the
listed survivors persist, and re-login refills caches from the server. `FAIL`
on any readable residue of the departed account, on B seeing A's data, or on
logout hanging or erroring. `BLOCKED` when two test accounts or server-side
token revocation are unavailable.

## Evidence

Keep before/after storage inventories per path (database names and
`first-tree:*` keys with values redacted), the console log around each
sign-out, and B's view of the chats A had cached. Never retain real tokens,
message plaintext, or image bytes in the report.
