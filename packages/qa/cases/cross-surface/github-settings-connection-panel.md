---
id: github-settings-connection-panel
description: Verify the Settings→GitHub connection panel — member-vs-admin permission split, GitHub App install/connect/disconnect lifecycle, and the installation catalog — across the server API and web UI.
areas: [cross-surface]
surfaces: [server, web, github]
---

# GitHub Settings & App Connection Panel

## Goal

Verify the team-facing GitHub settings surface and its App-connection lifecycle across its real boundaries: the
member-readable-but-admin-mutable permission split, the connect → disconnect → reconnect lifecycle with its
installer/requester ownership gate, the admin-only install-URL and repository catalog, and the Settings → GitHub UI states.
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

## Operate and Observe

### Permission split (member-readable vs admin-only)

- As a **member**: `GET /orgs/:org/github-app-installation` and `/exists` are readable (200, or 404 when nothing is bound —
  never 403). Every mutation / catalog endpoint — `connect-panel`, `connect`, `disconnect`, `install-url`,
  `repositories` — returns **403**.
- As an **admin**: those same endpoints succeed, or degrade to **503** when the App is unconfigured (never 403 for an
  admin). Flipping only the role bit must flip the admin endpoints 200 ↔ 403 while the member-readable reads stay readable.

### Connect / disconnect lifecycle

- From a connected state (a bound installation), `disconnect` → `GET /` returns 404 and `connect-panel` shows the row as
  `connectable`. `connect` again → `GET /` returns 200 and `connect-panel` shows `connected-here`.
- `connect` enforces installation ownership: the caller's GitHub id must equal the installation's `installer` or
  `requester`. A non-owner admin gets 403 even holding org-admin. (Driving via a dev-callback stub, set the installation's
  `installer_github_id` to the caller to reach the happy connect.)
- `disconnect` needs only org-admin — the binding is the team's own resource. It does not uninstall on GitHub, so the row
  survives and is reconnectable from any panel.

### install-url and repositories (need App config or mock)

- `install-url` (admin, slug configured): 200 with an `installations/new` URL carrying a signed `state` JWT, plus a
  `Set-Cookie` for `oauth_state` (CSRF double-submit). Without a slug: 503 with an operator hint. A caller-supplied `next`
  must never be reflected verbatim (open-redirect guard — only an allowlisted path or the Settings default rides the signed
  state).
- `repositories` (admin, App key + reachable GitHub API/mock): 200 with the installation's repository catalog. Failure
  shapes carry distinct codes: no installation → 503 `no_installation`, suspended → 503 `suspended`, App unconfigured →
  503 `not_configured`, upstream blip → 502 `upstream`.

### Web UI (Settings → GitHub)

- Admin, connected: the connected account + type, "Connection" and "Source repos" section headings, and the
  "Manage connection" / "Manage on GitHub" / "Connection details" controls; the connect panel exposes Reinstall (step 1,
  when installed) and Disconnect (step 2).
- Admin, not connected: a "Connect GitHub" call-to-action.
- Member: the connection state stays readable, but every admin control (Manage / Disconnect / Connect / Reinstall /
  Install / Add source repo) is absent.
- No browser console errors on any state.

## Expected Result

`PASS`: the permission split holds (member reads, admin mutates), the connect/disconnect/reconnect cycle and its
installer/requester ownership gate behave as described, install-url/repositories succeed with an App/mock or degrade
gracefully without one, and the UI renders connected / not-connected / read-only states with no console errors.

`FAIL`: a reproducible defect — a member can mutate, an admin is denied read/connect, `connect` ignores the
installer/requester gate, `disconnect` leaves a stale binding, `install-url` reflects an arbitrary `next`, a distinct
failure code is wrong, or the panel throws a console error.

`BLOCKED`: the run cell cannot bootstrap login / web, or an App-dependent sub-path (real github.com install dialog, real
webhook secret) can be neither provisioned nor mocked.

`INCONCLUSIVE`: behavior was partial, unstable, or not attributable to the tested ref.

## Evidence

Keep the admin/member status matrix, the connect/disconnect/reconnect responses plus the DB installation row
(bound org, installer id), the `install-url` URL (redact the state JWT) and the `oauth_state` cookie presence, the
`repositories` payload, and UI snapshots or DOM text for the connected / not-connected / read-only states. Redact bearer
tokens, connect codes, the App private key, and the webhook secret.

## Limitations

The real github.com install dialog is a GitHub-hosted page and cannot be mocked; only the server-side install-url
construction and the post-install callback state are reachable in an isolated cell. Full webhook card delivery into a
followed chat belongs to `github-webhook-routing-regression.md`; a mock GitHub REST API proves First Tree's
request/parse/verify logic, not github.com's live responses.
