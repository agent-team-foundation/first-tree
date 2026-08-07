---
id: github-settings-connection-panel
description: Verify the Settings→GitHub connection panel — provider identity preflight, permission split, and GitHub App install/connect/disconnect lifecycle — across the server API and web UI.
areas: [cross-surface]
surfaces: [server, web, github]
---

# GitHub Settings & App Connection Panel

## Goal

Verify the team-facing GitHub settings surface and its App-connection lifecycle across its real boundaries: the
member-readable-but-admin-mutable permission split, the connect → disconnect → reconnect lifecycle with its
installer/requester ownership gate, the linked-identity and current-github.com-account preflight before installation, the
admin-only install-URL and repository catalog, and the Settings → GitHub UI states.
Product tests own deterministic per-endpoint checks; this case verifies the assembled deployment still wires the panel,
the org-scope helpers, and the installation lifecycle together.

Webhook ingest (signature verification, record-only install recording, delivery-id dedup, followed-chat card routing) is a
sibling concern — see `github-webhook-routing-regression.md`. This case covers the settings / panel / permission half and
only touches the webhook where an `installation.created` delivery records the row this panel then connects.

## Preconditions

- Use an isolated Docker plus temporary-worktree QA run cell. Web-UI checks need Postgres + server + web + a browser tool;
  the API permission matrix and lifecycle need only Postgres + server.
- Bootstrap login without real GitHub via the dev auth bypass (`NODE_ENV` != production and
  `FIRST_TREE_DEV_CALLBACK_ENABLED=1`). The dev-callback `installationId` query param stubs and binds a
  `github_app_installations` row, so a connected state is reachable without a real GitHub App.
- The admin-only `install-url` and `repositories` paths, and any real GitHub call, require the GitHub App config block —
  all five `FIRST_TREE_GITHUB_APP_*` fields set together (plus `_SLUG` for install-url). A partial block is rejected at
  boot by design. Without it, those endpoints degrade (503) — validate the degradation, or supply a **mock App** (mock
  slug / id / client id+secret / PKCS#8 private key / webhook secret) with `FIRST_TREE_GITHUB_API_BASE_URL` pointed at a
  mock GitHub REST API to validate the happy path end to end.
- To exercise the member (non-admin) path, either invite a second member or flip an existing member's `role` in the
  isolated QA DB. Roles are re-read per request, so an in-DB role flip on one user isolates the permission gate cleanly
  (the same token flips 200 ↔ 403 as the role bit changes).
- For the capability-gate browser path, prepare an active Team admin authenticated through Google/OIDC with no GitHub
  identity, then link a known GitHub identity to that same First Tree user. A local database fixture may stand in for the
  external provider callback only when the report marks the OAuth-provider segment as substituted; it must not create a
  second First Tree user or alter Team membership.

## Operate and Observe

### Permission split (member-readable vs admin-only)

- As a **member**, the two member-readable endpoints have distinct unbound contracts: `GET /orgs/:org/github-app-installation`
  returns 200 with the installation when one is bound and **404** when none is (never 403); `GET /exists` is a redacted
  presence bit that **always returns 200** with `{ exists: boolean }` (never 404 — that invariant is what lets invitee
  onboarding distinguish "no install" from "not permitted"). Every mutation / catalog endpoint — `connect-panel`,
  `connect`, `disconnect`, `install-url`, `repositories` — returns **403** for a member.
- As an **admin** (org-role satisfied), the role-based 403 is lifted: the admin-only endpoints no longer deny **on org-role
  grounds**. Each then returns its own endpoint-specific outcome — 200 on success; 503 when the App is unconfigured; and,
  for the stateful routes, their own authorization/state errors (`connect` still 403 when the caller is not the
  installation's installer/requester, and 404/409 for an unknown or already-connected installation; `disconnect` 404 when
  nothing is bound). Do not assert an absolute "admin never 403" — the ownership gate below is a legitimate admin 403.
- The **org-role gate is the isolated variable**: with each endpoint's own happy-path preconditions satisfied, demoting
  only the caller's org role turns the admin-only routes' admitted result into a role 403, while the member-readable reads
  stay readable; promoting the caller back removes that role-based 403 but does not bypass the `connect` ownership gate or
  the state errors.

### Connect / disconnect lifecycle

- From a connected state (a bound installation), `disconnect` → `GET /` returns 404 and `connect-panel` shows the row as
  `connectable`. `connect` again → `GET /` returns 200 and `connect-panel` shows `connected-here`.
- `connect` enforces installation ownership: the caller's GitHub id must equal the installation's `installer` or
  `requester`. A non-owner admin gets 403 even holding org-admin. (Driving via a dev-callback stub, set the installation's
  `installer_github_id` to the caller to reach the happy connect.)
- `disconnect` needs only org-admin — the binding is the team's own resource. It does not uninstall on GitHub, so the row
  survives and is reconnectable from any panel.

### GitHub identity gate and installation preflight (need App config or mock)

- An active Team admin with no linked GitHub identity sees `Connect your GitHub account` and one `Continue with GitHub`
  action in the existing panel; Install is absent. `install-url` fails 409 `github_identity_required` before signing state
  or setting a nonce cookie. A member sees neither capability action.
- Account-link success returns to the same Team's `/settings/github` Connection section, shows `GitHub connected as
  @<login>`, and exposes Install as a second explicit action. Cancel, conflict, and expired-state returns preserve the
  First Tree session and one clear retry path. An external, protocol-relative, unrelated, or malformed `next` falls back
  to the supported Account settings route instead of becoming a redirect.
- `install-url` (linked admin, slug configured): 200 with a GitHub OAuth authorize URL carrying a signed identity-phase
  `state`, plus a protected `oauth_state_nonce` cookie. The callback must re-read the kickoff user's active Team-admin
  membership and linked numeric GitHub ID. A matching github.com account receives a fresh installation-phase state/cookie
  and redirects to `installations/new`; a mismatch, role loss, missing identity, missing code, or expired/replayed state
  fails before the picker. A code-bearing callback after the picker rechecks numeric identity before persisting any
  foreign identity. The mismatch surface names the expected linked login and returns to Settings → GitHub.
- A completed non-owner installation request returns without a code only during the installation phase, lands on the
  kickoff surface only after rechecking that the kickoff user is still an active Team admin with a linked GitHub identity,
  then waits for the signed webhook row; delayed owner approval makes the installation appear through polling without
  refresh or a duplicate request. GitHub supplies no OAuth code on this landing, so First Tree cannot prove the current
  github.com session. A deliberate cross-tab account switch after the picker opened can therefore create an unbound row,
  but it cannot bind the installation or cross Team authority boundaries. Without a slug: 503 with an operator hint. A
  caller-supplied `next` must never be reflected verbatim (open-redirect guard — only an allowlisted path or the Settings
  default rides signed state).

### repositories (need App config or mock)

- `repositories` (admin, App key + reachable GitHub API/mock): 200 with the installation's repository catalog. Failure
  shapes carry distinct codes: no installation → 503 `no_installation`, suspended → 503 `suspended`, App unconfigured →
  503 `not_configured`, upstream blip → 502 `upstream`.

### Web UI (Settings → GitHub)

- Admin, connected: the connected account + type, "Connection" and "Source repos" section headings, and the
  "Manage connection" / "Manage on GitHub" / "Connection details" controls; the connect panel exposes Reinstall (step 1,
  when installed) and Disconnect (step 2).
- Admin, not connected: a "Connect GitHub" call-to-action.
- Google/OIDC admin without GitHub identity: after opening Connect, only the inline link-account state appears. After the
  identity is linked and the same Team is restored, the panel shows the linked login and Install remains a separate click.
- Install preflight mismatch: the current First Tree session and selected Team remain unchanged; the recovery message
  names the expected GitHub login and offers a retry rather than opening the picker.
- Member: the connection state stays readable, but every admin control (Manage / Disconnect / Connect / Reinstall /
  Install / Add source repo) is absent.
- No browser console errors on any state.

## Expected Result

`PASS`: the identity gate and two-phase install preflight fail closed before the picker on identity mismatch and never
persist a foreign First Tree identity; no-code request landings recheck live Team admin and linked-identity authority;
the permission split holds (member reads, admin mutates), the connect/disconnect/reconnect cycle and its installer/requester
ownership gate behave as described, install-url/repositories succeed with an App/mock or degrade gracefully without one,
and the UI renders connected / not-connected / read-only states with no console errors.

`FAIL`: a reproducible defect — a member can mutate, an admin is denied a member-readable read, an admin-only route denies
purely on org-role grounds once its own preconditions are met, an admin without GitHub identity can mint install state, a
github.com account that mismatches during preflight reaches the picker, a code-bearing mismatch creates a First Tree
identity, account linking returns to the wrong
Team, `connect` ignores the installer/requester gate, `disconnect` leaves a stale binding, `install-url` reflects an
arbitrary `next`, a distinct failure code is wrong, or the panel throws a console error.

`BLOCKED`: the run cell cannot bootstrap login / web, or an App-dependent sub-path (real github.com install dialog, real
webhook secret) can be neither provisioned nor mocked.

`INCONCLUSIVE`: behavior was partial, unstable, or not attributable to the tested ref.

## Evidence

Keep the admin/member status matrix, before/after provider summaries (provider and display login only), the side-effect-free
409 response, identity-match/mismatch callback outcomes, the connect/disconnect/reconnect responses plus the DB
installation row (bound org, installer id), the `install-url` URL (redact the state JWT) and protected
`oauth_state_nonce` cookie presence, the `repositories` payload, and UI snapshots or DOM text for the identity-required,
connected / not-connected / read-only states. Redact provider numeric IDs, bearer tokens, OAuth codes, connect codes, the
App private key, and the webhook secret.

## Limitations

The real github.com sign-in/install dialog and owner approval are GitHub-hosted and cannot be faithfully mocked. Browser
evidence can cover First Tree's inline capability states and return behavior; deterministic integration tests cover state
rotation, numeric-ID match/mismatch, role loss, no-code request landing, polling, and side-effect boundaries. Full webhook
card delivery into a followed chat belongs to `github-webhook-routing-regression.md`; a mock GitHub REST API proves First
Tree's request/parse/verify logic, not github.com's live responses. In particular, GitHub's no-code owner-approval landing
cannot attest which github.com account submitted the request after the picker opened; this case may leave an unbound row but
cannot authorize a binding.
