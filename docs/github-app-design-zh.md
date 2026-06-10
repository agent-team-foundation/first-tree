# GitHub App Design

This document records the GitHub App decisions referenced from code comments.
The filename keeps the historical `-zh` suffix, but the repository standard is
to write technical documentation in English.

## D0a: One GitHub App, SaaS-Wide

First Tree uses one centrally configured GitHub App per deployment. The App is
the trust boundary for GitHub identity, installation tokens, repository access,
and webhook delivery.

The server stores installation metadata in `github_app_installations`. The row
is a snapshot from GitHub webhooks, GitHub API reads, or the local development
stub; GitHub remains the source of truth for the live permission grant.

## D0b: GitHub App Settings Contract

Permissions are declared in the GitHub App settings page, not passed in OAuth
or install URLs. Install and authorize URLs only carry identity, callback, and
state parameters; GitHub renders the current App permission contract from the
App settings.

Repository permissions:

- `Administration`: Read and write
- `Contents`: Read and write
- `Pull requests`: Read and write
- `Issues`: Read-only
- `Metadata`: Read-only

Organization permissions:

- `Members`: Read-only

Subscribed events:

- `issues`
- `issue_comment`
- `pull_request`
- `pull_request_review`
- `push`
- `installation`
- `installation_repositories`
- `member`

Operator rollout note:

- Operators must update the GitHub App settings to request
  `Administration: Read and write`.
- Existing installations must re-approve the permission upgrade in GitHub
  before relying on one-click Context Tree initialization.
- Until an installation is re-approved, initializer calls return
  `installation_permissions_insufficient`.

## D1: Login and Install Share the App Flow

The GitHub App has "Request user authorization (OAuth) during installation"
enabled. A first-time user can install the App and authorize identity in the
same GitHub round trip, while a returning user can authorize without changing
the installation.

First Tree signs and verifies `state` for CSRF protection and for recovering
the intended post-auth destination. Install CTAs use the App installation URL
when the UI needs a repository picker and permission review; identity-only
sign-in uses the App authorize URL.

## D2: One Installation Binds to One First Tree Team

Each GitHub App installation may bind to at most one First Tree team. The
server enforces this with the `github_app_installations.hub_organization_id`
binding and refuses to rebind an installation that is already claimed by a
different team.

This keeps repository grants, webhook fan-out, Context Tree initialization, and
team membership semantics aligned around a single team boundary.

## D3: Legacy OAuth and Per-Repo Webhooks Are Removed

The GitHub App is the GitHub integration surface. Legacy per-repository OAuth
and webhook setup paths are not part of the current contract; remaining code
must tolerate historical identity metadata only where needed for migration and
returning users.

Webhook ingestion enters through the GitHub App webhook endpoint and uses the
installation registry to resolve team ownership.

## D4: Webhooks Drive Installation State

GitHub installation, repository-selection, and member-related events refresh
First Tree's installation snapshot. The stored `permissions` and `events`
fields are forward-compatible records so new GitHub keys can be surfaced
without a schema migration.

Runtime actions that require stronger permissions, such as one-click Context
Tree initialization, must gate on the live installation token response rather
than assuming the stored snapshot is current.
