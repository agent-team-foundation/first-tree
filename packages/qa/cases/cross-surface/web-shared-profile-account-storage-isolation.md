---
id: web-shared-profile-account-storage-isolation
description: Verify logout and account, server, and organization switching cannot expose or recreate another identity's persistent Web data in one browser profile.
areas: [cross-surface]
surfaces: [web, server]
---

# Shared-Profile Web Storage Isolation

## Goal

Verify the assembled Web product keeps every authenticated browser-persistent store inside the exact server + account
scope and the exact organization view, and that logout waits for verified deletion before it reports completion or
navigates. The next account must be unable to read or render the prior account's messages, images, drafts, read anchors,
selected team, onboarding/install handoff, or other account-bearing state—even when identifiers collide and stale work
finishes late.

Product tests own deterministic state-machine and store assertions. This case covers browser scheduling, multiple tabs,
IndexedDB connection queues, BFCache/page lifecycle, HTTP and WebSocket proxy behavior, native image caching, and visible
UI results through a real persistent Chromium profile.

## Preconditions

- Reach `QA READY` with the repository's complete temporary-worktree + isolated Docker run cell before selecting the
  live scenario. Include production-style built Web/Server/Postgres and a separately drivable Vite origin whose upstream
  can be switched between two isolated Server/Postgres pairs S1 and S2.
- Use one disposable Chromium user-data directory and at least three tabs. Create independent users A and B plus two
  organizations for A. Prepare distinct server-side chat/attachment data and deliberately colliding chat, message,
  image, and agent identifiers where the live fixture supports it.
- Retain redacted browser network/console evidence, server request counters, and storage database/key inventories.
  Never record token values, OAuth capabilities, invite tokens, repository URLs, message bodies, or image bytes in the
  shared report.
- Every tab must already run the fixed bundle. A mixed old/new-bundle profile is never a passing configuration: all
  pre-fix tabs must close or reload first. Confirm that the fixed bundle repeats the exact legacy scrub on every boot and
  logout so residue written by a subsequently closed old tab is removed.

## Operate and Observe

### Account switch and verified logout

1. Sign in as A on S1. In organization A1, create a unique chat message, attachment/image, unsent existing-chat draft,
   unsent new-chat draft, read position, selected-team state, and representative onboarding/Settings transient state.
   Confirm ordinary refresh restores A's hot cache and server-wins data without exposing the static auth veil.
2. Hold a real A-scoped IndexedDB connection in a second fixed-bundle tab, start logout in the first tab, and verify the
   UI veils before any microtask or navigation. The delete may report blocked/recovery progress, but logout must not
   complete, offer a keep-local choice, or navigate while the connection remains open.
3. Close/reconcile the held tab. Verify the original or successor delete queue reaches terminal success, every scoped
   database disappears, account-bearing Web/session storage is absent, and only then logout completes. Repeat logout to
   prove idempotence and repeat the exact legacy scrub.
4. Sign in as B on S1 using the same profile and colliding identifiers. Through both store-backed UI and fresh server
   reads, verify no A message text, image/data URL, draft, read anchor, team, agent, repository, onboarding, install, or
   summary state can be read or rendered. Verify B's own cache, image, draft, and selected team work normally.

Also retain an A physical database deliberately in a controlled branch (without making logout claim success) and prove
that B still cannot read it through store APIs or DOM. This distinguishes namespace isolation from successful deletion.

### Late work, tabs, and lifecycle

- Pause an A message/query response, attachment fetch, image write, draft autosave/rollback, read-anchor flush,
  onboarding mutation, upload, timer, and WebSocket frame/reconnect. Complete A retirement and populate B, then release
  each continuation. B credentials, QueryClient sentinel, selected organization, persistent rows, React identity, and
  DOM must remain unchanged.
- Exercise a pending IndexedDB open and a stale `onupgradeneeded` after retirement. They must close/abort and must not
  recreate a deleted A database. Interrupt a shared holder with `pagehide`/freeze; a successor purge/delete barrier must
  absorb any orphan work, and delayed callbacks may not clear the durable retirement state.
- Exercise reload, a new tab, ordinary hidden/visible, pagehide, Back, and BFCache where Chromium admits it. Ordinary
  hidden/visible preserves valid A foreground work and offline hot state; pagehide/BFCache snapshots veil synchronously
  and reveal only after durable reconciliation. If Chromium does not enter BFCache, record that branch as
  `INCONCLUSIVE`, not simulated PASS.
- Repeat A→A explicit reauthentication and A1→A2→A1 organization switches. A newer same-account epoch survives an
  extremely late old-epoch retirement. A late A1 local/network/WS completion cannot populate the visible A2 view, while
  deliberate return to A1 may reuse only its correctly scoped cache. A disappeared membership never falls back to a
  different organization.

### Server retarget and transport firewall

- Keep an authenticated old S1 fixed-bundle tab alive, restart/retarget the same Vite origin to S2, and trigger JSON,
  raw upload/download, refresh, token-producing, invite/capability URL, and org WebSocket traffic. The Vite authority
  firewall must reject before S2 receives any business path, organization identifier, Authorization/Cookie, refresh
  body, upload/message body, upgrade path, or auth frame.
- A fresh S2 bundle must identify S2 anonymously before reading/sending stored credentials, reject the S1 session, purge
  only the S1 namespace, and remain anonymous until a separately validated S2 sign-in.
- For uploaded public agent avatars, cover a current UUID and an upgraded historical identifier such as
  `github-adapter`. Prove matching authority-tagged native `<img>` cache miss/hit behavior, stable same-server restart,
  forced S1→S2 miss rejection with zero S2 avatar business request, and fresh S2 data using a different authority tag.
  A warm immutable public S1 avatar byte may remain a permitted cache hit because it is outside account content.

### HTTP cache boundary

- Observe every authenticated Web GET using `cache: no-store`; logout's cache-eviction request is credential-free and
  the response carries `Clear-Site-Data: "cache"` plus `Cache-Control: no-store`.
- Use Chromium network/CDP evidence and server counters to show B did not reuse A's authenticated attachment response in
  this run. An observed eviction response is not proof that the user agent erased every disk byte. Browser-wide or
  forensic cache erasure remains explicitly unsupported/`INCONCLUSIVE`.

## Expected Result

`PASS`: after the complete fixed-bundle precondition, A's account-scoped persistent bytes are verified absent when
logout completes; B and S2 cannot read or render A/S1 data even with colliding identifiers or retained residue; late
work cannot recreate or deliver retired data; organization views remain isolated; and the Vite HTTP/WS firewall exposes
zero mismatched business traffic.

`FAIL`: logout completes or navigates before required deletion; account-bearing browser storage remains after reported
completion; B/S2 or another organization reads/renders A data; a stale continuation recreates storage or mutates the
new view; Back/BFCache flashes retired content; or a mismatched upstream receives a protected path, identifier,
credential, body, upgrade, or auth frame.

`BLOCKED`: the complete harness cannot reach `QA READY`, two isolated authorities or a persistent real browser cannot be
driven, or authentication/data fixtures cannot be established.

`INCONCLUSIVE`: BFCache/cache behavior is not entered or observable, deletion/proxy evidence is incomplete, or a result
cannot be attributed to the tested ref. Mixed old/new bundles are always `INCONCLUSIVE` and never PASS.

## Evidence

Keep redacted screenshots/DOM assertions for A, logout recovery, and B; the timed logout/navigation sequence; database
names and row counts with values omitted; lifecycle/BFCache events; delayed-operation barriers; S1/S2 request counters;
WS upgrade/frame traces; native-avatar cache evidence; and Chromium network events showing whether responses came from
disk cache. Record unsupported browser-cache erasure and any BFCache non-admission as limitations.
