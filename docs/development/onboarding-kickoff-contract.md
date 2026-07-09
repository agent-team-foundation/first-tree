# Onboarding Kickoff Contract

This note defines the compatibility boundary for web-created onboarding kickoff
chats and the adjacent campaign quickstart handoff.

## Current Contract

- `POST /api/v1/me/onboarding/kickoff` starts the user's first onboarding chat.
- The first message is visible task text sent through task `createChat`; the
  agent sees the same message the user sees.
- Skill activation comes from the visible message, bound resources, and skill
  descriptions. The client must not append hidden onboarding directives from
  message metadata.
- Campaign quickstart starts through `POST /api/v1/me/landing-campaigns/start`.
  That server-owned path creates the trial chat, binds the managed trial prompt
  guardrail, and wakes the agent from visible task text. The campaign skill is
  not server-materialized: the kickoff message instructs the trial agent to
  clone the campaign's skill repo and run the named skill on the connected repo.
- A `/me/onboarding/kickoff` request carrying `campaign` is a stale quickstart
  request. It must not create an onboarding kickoff chat or campaign idempotency
  key; it returns `410 campaign_kickoff_moved` when landing campaigns are enabled
  and `404 feature_disabled` when they are disabled.
- The first-chat endpoint does not accept the retired `kind` discriminator.
- `POST /api/v1/me/onboarding/tree-setup/kickoff` is the only tree setup
  kickoff entry. It uses the org-level `tree-setup` idempotency key.
- A `/me/onboarding/kickoff` request carrying `scanFixRepoSlug` (`owner/repo`)
  is a production-scan fix conversion arriving via onboarding. It keys the
  kickoff chat `<humanAgent>:scan-fix:<repoSlug>` instead of the default
  `<humanAgent>:<agent>:onboarding` key. This is the SAME key the
  already-onboarded direct path composes (`POST /api/v1/orgs/:orgId/chats` task
  mode, also from `scanFixRepoSlug`): both write `chats.onboarding_kickoff_key`,
  so its unique constraint makes re-entering the fix link — through either path
  — reuse the one fix launcher instead of creating a duplicate. It still stamps
  onboarding completion like any onboarding kickoff.

## Retired Contract Boundary

Older web bundles posted `kind: "intro" | "work" | "tree"` to
`/me/onboarding/kickoff`, and older server/client pairs used
`metadata.systemSender: "first_tree_onboarding"` plus optional `metadata.campaign`
as an agent-only activation directive.

Those request and prompt contracts are intentionally retired:

- A `/me/onboarding/kickoff` request carrying `kind` is rejected with
  `409 stale_onboarding_kickoff_contract`. The recovery is to refresh the web app
  and retry through the current endpoint contract.
- The client renders legacy onboarding metadata as ordinary message metadata; it
  does not append hidden instructions to the agent prompt. Campaign skill
  activation must not rely on a client-appended directive.
- Historical database rows whose `onboarding_kickoff_key` ends in `:tree` remain
  recognized by tree setup status reads so existing completed tree setup chats do
  not reappear as setup debt.

Do not reintroduce a compatibility shim that maps retired `kind` requests, routes
campaign quickstart through onboarding kickoff, or turns legacy onboarding
metadata into agent-only prompt text without a new product decision.
