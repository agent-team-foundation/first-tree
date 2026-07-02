# Onboarding Kickoff Contract

This note defines the compatibility boundary for web-created onboarding kickoff
chats.

## Current Contract

- `POST /api/v1/me/onboarding/kickoff` starts the user's first onboarding or
  quickstart chat.
- The first message is visible task text sent through task `createChat`; the
  agent sees the same message the user sees.
- Skill activation comes from the visible message, bound resources, and skill
  descriptions. The client must not append hidden onboarding directives from
  message metadata.
- The first-chat endpoint accepts `campaign` for quickstart idempotency and
  server-side managed-skill binding. It does not accept the retired `kind`
  discriminator.
- `POST /api/v1/me/onboarding/tree-setup/kickoff` is the only tree setup
  kickoff entry. It uses the org-level `tree-setup` idempotency key.

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
  does not append hidden instructions to the agent prompt.
- Historical database rows whose `onboarding_kickoff_key` ends in `:tree` remain
  recognized by tree setup status reads so existing completed tree setup chats do
  not reappear as setup debt.

Do not reintroduce a compatibility shim that maps retired `kind` requests or
turns legacy onboarding metadata into agent-only prompt text without a new
product decision.
