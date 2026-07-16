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
- `POST /api/v1/orgs/:orgId/context-tree/setup-chat` is the only Context Tree
  setup kickoff entry. It requires an org admin, accepts only the selected
  agent, owns the canonical topic/bootstrap on the server, uses an initiating
  human + selected-agent `tree-setup` idempotency key, and never stamps
  onboarding completion. The chat is an ordinary private task chat; an org-wide
  key must not cross private-agent ownership boundaries.
- A retired `<organization>:tree-setup` chat is re-keyed and reused only when
  its complete membership is exactly the initiating human and selected agent,
  preserving safe Phase 1 history. Any ownership mismatch leaves the legacy
  chat untouched and creates the caller's scoped chat instead.
- A `/me/onboarding/kickoff` request may carry `stamp` to say how the
  membership's onboarding state is stamped once the kickoff chat exists:
  `"completed"` (default, same as the older `complete: true`), `"none"`
  (same as `complete: false`), or `"invitee_skip"` — the team-agent start.
  `"invitee_skip"` is used when a joining member starts their first chat with a
  teammate's org-visible agent instead of creating their own: it writes only
  the auto-open suppressor (`onboarding_suppressed_reason = "invitee_skip"`),
  never `onboarding_completed_at`, so the standard connect-computer →
  create-agent journey stays pending and resumable. `stamp` supersedes
  `complete` when both are present; the kickoff key stays the normal
  `<humanAgent>:<agent>:onboarding` key, so a team-agent start and a later
  personal-agent start-chat are distinct chats.
- A campaign result action carries `campaignAction: { campaign, repoSlug }`
  through either `/me/onboarding/kickoff` or the already-onboarded direct task
  path (`POST /api/v1/orgs/:orgId/chats`). Both endpoints compose the same
  server-owned `chats.onboarding_kickoff_key`, so re-entering an action link
  through either path reuses one launcher. Production Scan retains its deployed
  `<humanAgent>:scan-fix:<repoSlug>` key; this keeps existing chats and stale web
  bundles compatible without a data migration. `scanFixRepoSlug` remains a
  legacy input that normalizes to `{ campaign: "production-scan", repoSlug }`;
  requests must not send both fields. An onboarding action still stamps
  completion like any onboarding kickoff.
- Campaign action fields belong only to the signed-in Web DTO
  (`CreateWebTaskChat`). The agent SDK's `CreateTaskChat` type and
  `/api/v1/agent/chats` contract do not expose them; a raw agent request that
  attempts either field is rejected rather than silently receiving Web-user
  authority.

## Retired Contract Boundary

Older web bundles posted `kind: "intro" | "work" | "tree"` to
`/me/onboarding/kickoff`, and older server/client pairs used
`metadata.systemSender: "first_tree_onboarding"` plus optional `metadata.campaign`
as an agent-only activation directive.

Those request and prompt contracts are intentionally retired:

- A `/me/onboarding/kickoff` request carrying `kind` is rejected with
  `409 stale_onboarding_kickoff_contract`. The recovery is to refresh the web app
  and retry through the current endpoint contract.
- The retired `/me/onboarding/tree-setup/kickoff` route is authenticated and
  non-mutating; it returns `410 tree_setup_kickoff_moved` so a stale browser tab
  gets an explicit refresh boundary rather than an ambiguous 404.
- The client renders legacy onboarding metadata as ordinary message metadata; it
  does not append hidden instructions to the agent prompt. Campaign skill
  activation must not rely on a client-appended directive.
- Historical database rows whose `onboarding_kickoff_key` ends in `:tree` remain
  recognized by tree setup status reads so existing completed tree setup chats do
  not reappear as setup debt.

Do not reintroduce a compatibility shim that maps retired `kind` requests, routes
campaign quickstart through onboarding kickoff, or turns legacy onboarding
metadata into agent-only prompt text without a new product decision.
