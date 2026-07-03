# First Tree Scan Growth System Proposal

**Status:** Draft
**Date:** 2026-07-03
**Scope:** Product, growth flow, scan skill, hosted trial agent, report sharing, and conversion loop

## Summary

First Tree Scan is the external product name for First Tree's reusable scan-led
growth system.

The goal is not to ship a one-off marketing campaign. The goal is to build a
stable, repeatable acquisition and activation loop:

```text
Landing page
-> repo input
-> hosted Trial Scan Agent
-> actionable scan result
-> user-approved next action
-> shareable Scan Report
-> setup CTA
-> full First Tree onboarding
-> long-term team agent workflow
```

Once this loop is stable, future growth experiments should mostly require a new
landing page and a new scan skill. The underlying handoff, hosted trial runtime,
report sharing, attribution, and onboarding conversion path should be reusable.

## Naming

Use **First Tree Scan** as the external product name.

Use **Scan Flow** as the internal abstraction for a specific scan type, such as
`production-scan` or `agent-readiness`.

Recommended terms:

| Concept | Preferred Term | Notes |
|---|---|---|
| External product line | First Tree Scan | Used in landing pages, reports, attribution, and user-facing copy. |
| Specific scan type | Scan Flow | Internal product/technical abstraction. |
| One-off official scan agent | Trial Scan Agent | First Tree-managed agent that runs one scan and one action loop. |
| Shareable result page | Scan Report | Public report page and screenshot card. |
| Post-scan conversion prompt | Setup CTA | One value-first invitation into First Tree onboarding. |

Current code still uses `landing-campaign` and `campaign` in several places.
That naming can remain temporarily to avoid churn, but new product docs and new
modules should use `scan`, `scanFlow`, and `First Tree Scan`.

## Product Positioning

First Tree's core product is the team agent workspace and context loop:

```text
team context
-> agent work
-> human review/control
-> durable outcome
-> improved team context
```

First Tree Scan is the low-friction value trial in front of that product. It lets
a user experience a useful agent workflow before they understand or configure
the full system.

The promise is:

> Paste a repo. Get a useful scan. Take the first action immediately. Then set
> up First Tree so this kind of help is available on every task.

This matters because a report alone is weak. The stronger product experience is
diagnosis plus action:

```text
Trial Scan Agent
-> finds evidence-backed issues
-> explains the risk
-> offers concrete actions
-> user approves one action
-> agent produces or applies the first artifact
-> report and outcome become shareable
```

The Scan Report is the distribution asset. The action loop is the conversion asset.

## Full User Journey

### 1. External Discovery

Users can enter a First Tree Scan from:

- a public landing page
- a shared Scan Report URL
- a saved PNG report card
- a GitHub issue or PR attribution line
- social posts
- blog/SEO pages
- README links
- direct teammate referral

The first production version is the production readiness scan landing page in
`first-tree-website`, not the temporary hub `/scan/:campaign` surface.

### 2. Scan Landing Page

The landing page has a narrow job:

- explain the scan promise
- show a concrete output example
- collect a GitHub repo URL
- validate the repo URL
- hand the user to Cloud quickstart with scan intent

It should not create agents, run scans, own login recovery, or manage onboarding.

The current production scan landing in `first-tree-website` has the right shape:
repo input, strong example output, and a handoff to Cloud quickstart. The latest
local worktree change points the handoff to:

```text
https://cloud.first-tree.ai/quickstart?campaign=production-scan&repo=<repo>
```

Future naming can become:

```text
https://cloud.first-tree.ai/quickstart?scan=production-scan&repo=<repo>
```

### 3. Quickstart Handoff

The hub quickstart page owns auth recovery and intent preservation.

Responsibilities:

- read the scan intent from URL query/hash
- persist it through the login/OAuth round trip
- fail closed when the growth/scan feature flag is disabled
- call the server start endpoint
- redirect the user to the created trial chat

Important design point: quickstart does not wait for a local computer and does
not create the user's long-term agent. It opens a hosted trial workflow first.

### 4. Trial Scan Provisioning

The server creates or reuses the trial infrastructure:

- First Tree official service member in the user's organization
- Trial Scan Agent pinned to the official runtime client
- agent-private scan skill resource
- locked single-run trial chat
- bootstrap message addressed to the Trial Scan Agent

This is intentionally server-owned. The browser supplies only the scan slug and
repo URL. The scan skill body, agent metadata, resource binding, and chat
metadata are trusted server state.

The current implementation requires an organization admin to start the trial.
That may be correct for now, but it should remain a product decision: if the
scan is meant to be a public/free top-of-funnel product for non-admin invitees,
the permission model will need a deliberate adjustment.

### 5. Trial Scan Agent Execution

The Trial Scan Agent runs the Scan Flow skill.

The skill must:

- read the target repo before judging
- cite concrete evidence from that repo
- avoid generic advice
- avoid invented problems
- score healthy repos fairly
- produce a structured result
- produce a short human-readable summary
- identify the highest-value next action
- ask before doing any write action
- avoid leaking internal workspace mechanics
- send the setup CTA only after the action offer is resolved

### 6. Action Loop

This is the key product correction: First Tree Scan should not stop at a report.

After the scan, the Trial Scan Agent should offer concrete actions based on the
findings. Examples:

- generate a ready-to-apply diff
- open a GitHub issue
- open a GitHub PR
- generate or improve `AGENTS.md`
- add a CI workflow
- add `SECURITY.md`
- draft a hardening checklist
- split blockers into GitHub issues
- run a focused follow-up scan on one risk area
- scan another repo

Action rules:

- The default posture is read-only.
- Writes require explicit user approval through an ask-user card.
- The agent must not push to a default branch.
- The agent must not mutate existing PRs/issues without explicit scope.
- If `gh` is unavailable or unauthenticated, the agent should provide the exact
  command for the user to run.
- The setup CTA should not interrupt an unresolved action.

The user experience should be:

> Here is what I found. Here is the first useful thing I can do for you. Pick
> one, and I will prepare it.

The report proves competence. The action proves usefulness.

### 7. Scan Report and Sharing

The Scan Report is the shareable artifact.

The website already has the right foundation:

- canonical report route, currently `/production-scan/r/<id>`
- a report card component
- native Share button
- copy-link fallback
- Save as PNG
- Redis-backed report storage API

The missing product/technical link is that the hub scan skill does not yet
clearly generate and publish the website report payload.

The complete flow should be:

```text
Trial Scan Agent completes scan
-> builds report payload
-> POSTs to first-tree-website /api/reports
-> receives report URL
-> shares URL in chat
-> user can share report URL or PNG
-> shared report has CTA back to First Tree setup
```

Report pages should carry attribution parameters where possible, so a shared
report can connect downstream signup and onboarding completion back to the
originating Scan Flow.

### 8. Setup CTA and Conversion

After the scan result and action offer are resolved, the agent sends one setup
invitation.

The message should be:

- short
- value-first
- tied to what the user just received
- one link
- not a menu
- not repeated after a no

The positioning:

> This scan was a one-time patch. Set up First Tree to have this kind of agent
> help available on every task, for your own team, on your own machine.

The setup CTA leads into the normal onboarding path:

- team setup
- computer connection
- user-owned agent creation
- code connection
- first real workspace task

## Current Implementation State

### Hub: Implemented or Mostly Implemented

- Feature flag for growth landing/scan flows.
- Quickstart intent handling for scan handoff.
- `POST /api/v1/me/landing-campaigns/start`.
- Official service-managed trial agent provisioning.
- Agent-private scan skill binding.
- Locked single-run trial chat.
- Trial chat state machine: `running`, `awaiting_user`, `completed`, `failed`.
- Guardrails preventing ordinary chat use of trial agents.
- Codex app-server workspace-only runtime for trial agents.
- Scoped outbox token for sandboxed message posting.

### Website: Implemented or Mostly Implemented

- Production scan landing page.
- Production scan report route.
- Shared Scan Report component.
- Share button.
- Save as PNG button.
- Report storage API backed by Redis.
- Sample report data.

### Not Yet Closed

- End-to-end flow has not been fully tested.
- The scan skill does not yet clearly publish report payloads to the website.
- The scan result schema and website report schema are not a single explicit
  contract.
- Share/referral attribution is not complete.
- Setup CTA attribution is not complete.
- Manual scan skill evaluation is still a major open workstream.
- Production scan handoff update in the website worktree is currently local and
  not committed there.

## Architecture

### Website Layer

Repository: `first-tree-website`

Responsibilities:

- public scan landing pages
- scan report pages
- report storage API
- social/share surfaces
- SEO surfaces

Important files in the current production scan flow:

- `src/pages/production-scan.astro`
- `src/pages/production-scan/r/[id].astro`
- `src/components/ScanReport.astro`
- `src/pages/api/reports/index.ts`
- `src/pages/api/reports/[id].ts`
- `src/lib/scanSample.ts`

### Hub Web Layer

Repository: `first-tree-hub`

Responsibilities:

- quickstart intent recovery
- auth/login handoff
- calling the scan start API
- redirecting into the workspace chat

Important files:

- `packages/web/src/pages/quickstart/quickstart-page.tsx`
- `packages/web/src/pages/quickstart/intent.ts`
- `packages/web/src/pages/quickstart/campaigns.ts`
- `packages/web/src/api/landing-campaigns.ts`

Future naming should move from `campaigns.ts` to `scan-flows.ts` when the
migration is worth the churn.

### Hub Server Layer

Responsibilities:

- validate scan start requests
- create service member and trial agent
- bind scan skill resources
- create trial chats
- enforce trial chat/agent isolation
- expose setup URL to scan skills

Important files:

- `packages/shared/src/schemas/landing-campaign.ts`
- `packages/server/src/api/landing-campaigns.ts`
- `packages/server/src/services/landing-campaigns/start.ts`
- `packages/server/src/services/landing-campaigns/metadata.ts`
- `packages/server/src/services/landing-campaigns/guards.ts`
- `packages/server/src/services/landing-campaigns/skills/catalog.ts`
- `packages/server/src/services/resources.ts`
- `packages/server/src/services/message.ts`

### Runtime Layer

Responsibilities:

- materialize scan skills
- run Trial Scan Agents
- isolate hosted scan execution
- allow only scoped outbox posting
- prevent fallback to unsafe runtime paths

Important files:

- `packages/client/src/handlers/codex/index.ts`
- `packages/client/src/handlers/codex/app-server/index.ts`
- `packages/client/src/handlers/codex/app-server/workspace-sandbox.ts`
- `packages/server/src/api/agent/messages.ts`
- `packages/server/src/middleware/user-auth.ts`

## Report Contract

The report contract should become a formal shared spec between the scan skill
and the website.

Minimum report payload:

- `id`
- `repo`
- `owner`
- `scanDate`
- `score`
- `dims[]`
- `tally`
- `mustfix[]`
- optional `markdown`
- optional `calibration`
- optional `scanDepth`
- optional attribution fields:
  - `scanFlow`
  - `source`
  - `utmSource`
  - `utmCampaign`
  - `originChatId`
  - `originAgentId`

The scan skill should treat report publishing as part of the deliverable:

```text
1. Produce scan result.
2. Produce action recommendation.
3. Publish report.
4. Give user report URL.
5. Offer/complete one action.
6. Send setup CTA.
```

If report publishing fails, the user should still receive the useful chat
summary and action offer. The failure should not derail the scan unless the user
explicitly asked for a public report.

## Attribution and Analytics

First Tree Scan needs funnel analytics across website and hub.

Events to track:

- `scan_landing_viewed`
- `scan_repo_submitted`
- `scan_quickstart_opened`
- `scan_start_requested`
- `scan_trial_chat_created`
- `scan_agent_started`
- `scan_result_completed`
- `scan_action_offered`
- `scan_action_accepted`
- `scan_action_completed`
- `scan_report_published`
- `scan_report_shared`
- `scan_setup_cta_clicked`
- `scan_onboarding_started`
- `scan_onboarding_completed`
- `scan_user_agent_created`
- `scan_first_real_task_completed`

Attribution data should include:

- scan flow slug
- repo canonical key
- source URL
- UTM params
- report ID
- chat ID
- organization ID after login
- user ID after login

Public report URLs should support attribution without leaking private chat or
user data.

## Evaluation Plan

Manual evaluation is a first-class requirement. Unit tests are not enough for
the scan quality bar.

### Eval Dimensions

- Reads the target repo before judging.
- Cites real file paths and evidence.
- Does not invent issues.
- Scores healthy repos high.
- Prioritizes high-impact blockers.
- Produces an action the user can actually take.
- Uses ask-user for writes.
- Does not expose workspace internals.
- Handles `gh` unavailable/auth failures gracefully.
- Produces a share-worthy report.
- Sends setup CTA only after the action offer is resolved.
- Does not nag after a decline.

### Eval Repos

Use a small but varied corpus:

- small static site
- Node/Vite app
- backend API
- repo with known secret/config problems
- repo without CI
- mature healthy repo
- large monorepo
- repo with missing `AGENTS.md`
- repo with existing strong `AGENTS.md`

### Eval Scenarios

- User accepts PR creation.
- User rejects PR creation.
- User asks for issue instead of PR.
- `gh` is not authenticated.
- Report publishing fails.
- Repo is healthy.
- Repo is too large for one pass.
- User goes quiet after the report.
- User clicks setup CTA.

## Rollout Plan

### Phase 1: Production Scan End-to-End

Goal: make the current production scan flow work from website landing to hub
trial chat to report URL to setup CTA.

Tasks:

- Commit/ship website handoff to Cloud quickstart.
- Define the production scan report payload contract.
- Update `production-scan` skill to build the report payload.
- Add report API endpoint URL/config to the trial agent environment or skill
  instructions.
- Make the Trial Scan Agent return the report URL in chat.
- Manually test the full path.

### Phase 2: Action Loop Hardening

Goal: make the scan useful beyond a report.

Tasks:

- Tighten skill instructions for 1-3 action offers.
- Keep writes behind ask-user cards.
- Verify PR/issue creation flow.
- Verify fallback commands when `gh` is unavailable.
- Ensure setup CTA is sent only after the action offer is resolved.

### Phase 3: Sharing and Attribution

Goal: make scan outputs measurable and viral.

Tasks:

- Add report/share attribution fields.
- Add UTM/referrer preservation from landing to quickstart.
- Add setup CTA attribution.
- Track report share/save actions where feasible.
- Connect onboarding completion back to the originating scan flow.

### Phase 4: Eval and Quality Gate

Goal: prevent regressions before expanding to more scan flows.

Tasks:

- Build a manual eval checklist.
- Run production scan across the eval repo set.
- Record failure modes.
- Update skill copy and action rules.
- Add automated contract tests for report payload shape and start flow.

### Phase 5: Repeatable Scan Flow Template

Goal: make new First Tree Scan variants cheap to launch.

Tasks:

- Create a Scan Flow spec template.
- Document required landing page fields.
- Document required skill sections.
- Document report schema requirements.
- Document eval cases.
- Add a registry checklist so website and hub cannot drift silently.

## Future Scan Flow Candidates

The first reusable examples are:

- `production-scan`: launch/security/readiness scan.
- `agent-readiness`: whether a repo is ready for coding agents.

Potential future First Tree Scan variants:

- onboarding-readiness scan
- CI hardening scan
- security quick audit
- agent-instructions scan
- docs/readme quality scan
- deploy readiness scan
- dependency/supply-chain scan
- multi-agent workflow readiness scan

Each new scan should be judged by whether it can produce:

- a crisp landing promise
- a concrete report
- at least one useful action
- a shareable artifact
- a natural setup CTA

## Naming Migration

Do not block product work on renaming existing code.

Recommended migration path:

1. Use First Tree Scan in external copy immediately.
2. Use `scan`/`scanFlow` in all new docs and proposals.
3. Keep existing `landing-campaign` code until the flow stabilizes.
4. When touching files for functional work, rename opportunistically only if the
   blast radius is small.
5. Eventually migrate:

| Current | Future |
|---|---|
| `landingCampaign` | `scanFlow` |
| `campaign` | `scan` or `scanFlowSlug` |
| `landingCampaignTrialAgent` | `scanTrialAgent` |
| `landingCampaignStart` | `startScanFlow` |
| `/me/landing-campaigns/start` | `/me/scans/start` or `/me/scan-flows/start` |

## Open Questions

- Should non-admin users be allowed to start a Trial Scan Agent, or is admin-only
  required for the first rollout?
- Should report publishing be done directly by the agent, by the hub server, or
  by a dedicated report service?
- Should Scan Report storage live in `first-tree-website` long-term, or should
  hub own report persistence and website only render?
- How long should public reports live?
- Which attribution data can be public in report URLs, and which must remain
  private?
- Should setup CTA point to generic onboarding or a scan-specific onboarding
  path?
- How should a user scan private repos in a future version?

## Success Criteria

The production scan flow is stable when:

- A user can start from the website landing page and reach a trial chat.
- The Trial Scan Agent completes a scan on a real repo.
- The user receives a useful report and at least one actionable next step.
- The user can approve an action and receive a real artifact.
- A public Scan Report URL is generated.
- The report can be shared or saved as PNG.
- The setup CTA leads into onboarding.
- The funnel can attribute setup completion back to the scan flow.
- Manual eval passes on the agreed repo set.

The broader First Tree Scan system is stable when a new scan flow can be created
mostly by adding a landing page, a scan skill, a report contract, and eval cases.
