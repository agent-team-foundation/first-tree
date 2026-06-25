# GitHub App Slimming + Binding/Install Simplification (Design)

## Motivation

1. **Make users trust the GitHub App more** — least privilege.
2. **Make "bind GitHub + install the App" simpler.**

## Changes

1. **Slim the App.** Keep only `Metadata: read` + `Pull requests: read` + `Issues: read` + `Contents: read` (for web tree display only). Drop org `Members: read`, `Administration: write`, `Workflows: write`, `Pull requests: write`, `Contents: write`.

2. **Context Tree create/init/update → the agent via local `gh`** (off the App's server-side writes). The standard `repo` scope covers repo creation and reading/writing normal files. **The one exception** is `.github/workflows/validate-tree.yml` (writing under `.github/workflows/` requires the `workflow` scope).
   - **Granting `workflow` is interactive**: `gh auth refresh -s workflow` runs a GitHub OAuth re-authorization (device-code / browser) that **the user must approve by hand in the GitHub UI** — the agent cannot do it for them.
   - So the **preferred path = don't seed that workflow locally** (it is only an optional CI check; drop it or let the user add it later), which avoids the manual grant entirely.

3. **Drop the user/org distinction.** Both are symmetric as repo owners; `gh repo create <owner>/<name>` handles either → remove the provisioner's user/org branch (`ensureOrganizationRepo` / `ensureUserRepo` collapse into one).

4. **Org creator = install + login.** Stop probing the user's repo/org admin rights (remove the `verifyUserCanAdministerInstallation` probe); let GitHub's native install gating handle it: with rights → self-install; without → GitHub sends an approval request to the owner. This also removes `Members: read`'s **only consumer** (it was used solely for the `GET /user/memberships/orgs/{org}` org-admin probe).

5. **Invitee = login only.** An invitee is a First Tree org member; the team's **single** installation already covers the repos, so an invitee does not need to (and on a personal account *cannot*) install the App — only the account owner can install on a personal account; on an org it would be a redundant no-op.

6. **Record install success.** Already handled — the `installation.created` webhook → `upsertInstallationFromMetadata` writes `github_app_installations`. The web `GET /me/onboarding/tree-setup-status` probe + `findInstallationByOrg` expose status; invitees skip install based on it.

## Install / Login Flow (unified entry, conditional install)

- **Login is universal**: everyone does it; it establishes the identity → agent routing.
- **Install appears conditionally**: only when the team has no installation *and* the current user can install — for an org prompt owner / repo-admin; for a personal account only the creator can install.
- **No hard block**: a user can log in and enter the product even if install is not done (`finish-later` / `no_installation` graceful states / recovery probe already exist; tree setup is already admin-only). Install success is known **asynchronously**, and invitees skip it.

## Key Constraints / Risks

- **Binding anti-forgery (precondition for change 4)**: after removing the admin probe, **do not trust the browser-returned `installation_id`** (otherwise pasting someone else's id forges a binding). Anchor binding on the **`installation_id` returned directly by a merged install+login round-trip**, or on the **`installation.created` webhook**. So **change 4 depends on the merged install+login step.**
  - Note the `installation.created` webhook lands **unbound** (the webhook does not know which First Tree user installed it); binding to a team still needs one user claim (OAuth callback). The delayed-approval case (owner approves later) needs a "come back and claim" finish.
- **One team = one installation = one GitHub account** (schema `UNIQUE(hub_organization_id)`). Automation coverage = the repos that one installation selects.
- **The tree repo must be within the App installation's scope**, otherwise: (1) the Context Tree PR reviewer gets no PR webhook; (2) the web tree display's git-fetch cannot read it. Once the agent creates the tree repo (change 2), it must be added to the installation's repo selection (or install on "all repos").
- **`Contents: read` is the core trade-off.** It is an **installation-level** permission = it can read the source of **all granted repos** (not just the tree repo), which conflicts most with the trust goal. The web context page is two parts with different data sources:
  - **tree graph / dashboard** = server-side **git-fetch of the tree repo** (= `Contents: read`). **Dropping `Contents: read` breaks this** (`snapshotStatus: "unavailable"`).
  - **the context feed (IO activity + usage)** = from **`context_tree_io_events` and other DB telemetry**; it **never touches GitHub** → **survives without `Contents: read`** (write attribution degrades from "git-derived + telemetry reconciliation" to "telemetry only", but the feed itself stays).
  - ⚠️ Caveat: the UI currently gates the feed behind snapshot availability (when the snapshot is unavailable the whole page renders the "not ready" branch and the feed is hidden too). So "drop `Contents: read` but keep the feed" needs **a small change**: decouple `ContextUsageFeed` from the tree graph so it renders even when the snapshot is unavailable.
  - **Three options**: (4a) **keep `Contents: read`** → dashboard + feed both work (the default for now); (4b) **drop `Contents: read`** → dashboard degrades, feed kept after the decouple (full trust win, small change); (4c) build an **agent → server tree-snapshot upload** channel → zero source read *and* dashboard kept (full trust win, biggest effort, follow-up). **This iteration takes 4a; 4b/4c are follow-up options.**

## Context Tree Review Agent — No Conflict (researched)

`context-reviewer-pr.ts`:

- Triggered by **PR webhooks on the tree repo** (`pull_request` opened/synchronize, `issue_comment`); reviews **in a First Tree chat**.
- **No GitHub write, no server-side diff read** (the agent reads the diff locally via `gh`).
- It relies on the **retained `Pull requests: read` + `Issues: read`**, fully compatible with slimming.
- Same precondition as above: **the tree repo must be within the installation's scope** (so PR webhooks arrive).

**Conclusion: none of the 6 changes affect the Context Tree Review Agent.**

## Permission Diff (before → after)

| Permission | Now | After | Reason |
|---|---|---|---|
| org `Members: read` | ✓ | ✗ | only consumer (admin probe) removed |
| `Administration: write` | ✓ | ✗ | repo creation moves to local gh |
| `Workflows: write` | ✓ | ✗ | validate-tree.yml moves to local gh |
| `Contents: write` | ✓ | ✗ | tree writes move to local gh |
| `Pull requests: write` | ✓ | ✗ | automation is inbound-only, no write-back |
| `Contents: read` | ✓ | ✓ | web tree display only (trade-off) |
| `Pull requests: read` | ✓ | ✓ | routing + reviewer + live state |
| `Issues: read` | ✓ | ✓ | routing + reviewer + live state |
| `Metadata: read` | ✓ | ✓ | baseline repo access (GitHub-mandatory) |

Install gate: **owner-only → repo-admin self-serve** (after slimming, the App no longer requests org / administration permissions).

## Related

- Companion to `docs/github-app-design-zh.md`.
- #1301 — remove follow-commit (commit entity resolution). Note: since this iteration **keeps** `Contents: read`, #1301 no longer reduces the permission set, but is still worth doing (removes a dead feature + a source-commit-reading path).
