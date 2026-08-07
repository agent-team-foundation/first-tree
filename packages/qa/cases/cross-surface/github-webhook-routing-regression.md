---
id: github-webhook-routing-regression
description: Verify signed GitHub App webhooks reach followed chats and automatically route supported Issue and pull request activity to the repository-scoped Agent role.
areas: [cross-surface]
surfaces: [server, github, client, web]
---

# GitHub Webhook Routing Regression

## Goal

Verify the live GitHub App ingress-to-chat path across its real boundaries: HMAC authentication, installation-to-Team
resolution, normalized event processing, followed-chat routing, automatic repository-role task creation, card
persistence, Agent wake delivery, and terminal App publication. Product tests own deterministic payload and failure
matrices; this case checks that the assembled deployment still wires those parts together without string-matching the
App login or adding a GitHub-specific post-delivery branch.

## Preconditions

- Use an isolated Docker plus temporary-worktree QA run cell.
- Configure a GitHub App webhook secret and a bound, active installation for the test Team, with Issues and pull
  requests read/write permissions. Use disposable repositories and test identities; do not point a production App at
  the run cell.
- Create a chat with an eligible human/delegate pair and follow one disposable Issue or pull request in that chat.
- Select different active, organization-visible managed Agents for Context Reviewer and GitHub Task Agent. Use Settings
  → Getting Started for Context Reviewer and Settings → Integrations → GitHub → Automatic handling for GitHub Task
  Agent; confirm each surface rejects an assignment that would reuse the other role's Agent. Leave Automatic Review off
  for the first non-Context repository observations so ordinary automatic handling is proven independently from Context
  Review.
- Bind the Team's Context Tree to one GitHub repository. Use a second disposable GitHub repository for GitHub Task Agent
  observations. A GitLab Context Tree binding can be used as an additional negative control.
- Keep a matching client runtime connected if the plan includes observing the Agent wake. A missing provider credential
  may block the later model turn, but it must not prevent card and inbox evidence.

## Operate and Observe

- Open Settings → Integrations → GitHub. Confirm the section keeps the `#task-routing` URL but is labelled **Automatic
  handling**, explains that it covers Issue and pull request activity from connected repositories, says the selected
  Agent automatically handles non-Context activity and posts final replies as the First Tree GitHub App, and explains
  that Context Tree activity uses Context Reviewer. Repeat as an admin, member, and with no eligible Agent.
- Deliver a valid HMAC-signed webhook for the followed entity with a stable `X-GitHub-Delivery` value. Observe one GitHub
  card in the followed chat and the expected delegate inbox/session wakes. Inspect the delegate's assembled turn input
  and confirm both a current webhook card and a card carried as preceding silent context use
  `[From: GitHub · type=system ...]`, never the representative human carrier.
- Redeliver the same signed body with the same stable delivery id. Observe a successful deduplicated response and no
  second card, task run, or wake.
- Deliver an equivalent supported event without `X-GitHub-Delivery`. Confirm it is accepted without creating a
  `processed_events` claim. If the event is repeated, treat repeated side effects as the documented weak-reliability
  baseline rather than an exactly-once promise.
- Send a request with an invalid signature and confirm it is rejected before installation lookup, claim, card, task run,
  or wake.
- In the non-Context repository, deliver representative normalized Issue and pull-request events with no App mention,
  App assignment, or other personnel target. Include an external public contributor and vary `author_association`.
  Confirm every supported event creates or reuses one entity chat for the selected GitHub Task Agent, wakes that exact
  Agent, and persists `teamAgentTask: { agentUuid: "<selected UUID>", runId: "<server run>" }` on both the card and
  message metadata. The card must retain the real event kind, use reason `subscribed`, and omit `mentionedUser`.
- Repeat with real human mention, assignee, and review-request targets and with an independent followed line. Confirm
  those routes remain intact, the task and follow/personnel wakes union into one card per chat, and only real personnel
  evidence can set a directed reason or `mentionedUser`.
- Repeat a non-Context event where the GitHub actor already maps the entity to a different delegate. Confirm the selected
  GitHub Task Agent is added as a chat participant and is woken, while actor-echo suppression still applies only to the
  pre-existing human attention line. Repeat with unrelated attention lines in the same chat and confirm task identity
  remains recipient-scoped.
- In the bound GitHub Context Tree repository, deliver the same supported activity and confirm its automatic task uses
  Context Reviewer rather than GitHub Task Agent. Confirm repository matching tolerates canonical URL spelling, case,
  and `.git` differences. Verify the second GitHub repository still targets GitHub Task Agent, and that a GitLab Context
  Tree binding does not classify any GitHub repository as the Context repository.
- Remove or invalidate each role selection in turn and confirm only that automatic task is skipped; existing human
  targets and subscriptions still receive ordinary cards. Remove the verified App slug/login and confirm Settings →
  Integrations → GitHub → Automatic handling exposes a readiness blocker and runtime routing fails closed. Remove an
  accepted Issue or pull-request write grant and confirm the corresponding event reports
  `GITHUB_TASK_REPLY_APP_PERMISSION_REQUIRED` without a run while independent routes remain delivered.
- Let the GitHub Task Agent finish one automatically routed task. Confirm it treats the webhook actor/body as untrusted
  context, inspects the live entity through the normal host GitHub identity, limits work to that identity's permissions,
  then uses `first-tree github reply --run <runId> --body-file <path>` for the terminal outcome. A First Tree chat-only
  result or a terminal host-identity comment is incomplete.
- Observe the terminal App-authored comment webhook. When the comment author is exactly the configured `<slug>[bot]`
  `Bot` and the body carries a valid `first-tree-github-task-reply-run` marker, confirm its independent subscription card
  may still arrive but it creates no second task/run and does not trigger trusted Context Review. Repeat with the same App
  bot but no valid marker, and with a valid-looking marker from a user or different bot; each must remain ordinary event
  input and must not inherit the self-output suppression boundary.
- Retry the identical reply payload and confirm the same comment is returned without another GitHub write; race two
  identical submissions and confirm only one POST occurs, the in-flight loser may receive a stable unknown result from
  read-only reconciliation, and a later retry reads the winner's result. Change the payload and confirm rejection.
  Simulate an unknown GitHub write, then confirm retry reconciles the App actor, hidden run marker, and exact body before
  returning rather than blindly creating another comment. Zero matches, duplicate exact matches, and list failure must
  all remain unknown with no second POST.
- Attempt publication from a different Agent, client, runtime session, chat, repository-scoped role assignment, inactive
  membership, and spoofed user-authored `githubTask*` metadata. Confirm each fails before GitHub mutation. Confirm a reply
  that mentions the App is rejected. Historical boolean/no-run markers remain renderable but cannot publish.
- Deliver normalized Discussion and commit activity, plus installation lifecycle, observation-only, and currently
  filtered/noise events. Confirm none creates a provider task or task run. Existing applicable subscription or projection
  behavior remains unchanged.
- Redeliver a supported event with a fresh delivery id on the same entity. Confirm the existing repository-role chat and
  attention line are reused rather than creating another chat.
- Enable Context Reviewer and include one supported Context Tree PR trigger. Confirm it reuses its dedicated reviewer
  chat and retains trusted review publication authority only for that path. The ordinary automatic task card must not
  gain trusted App review or merge authority.

## Expected Result

`PASS`: signed events resolve through the bound installation, reach the expected chat and wake path, stable delivery ids
deduplicate the whole request, missing delivery ids do not claim, invalid signatures have no side effects, and optional
Context Reviewer behavior remains dedicated and claim-covered. Supported Issue and pull-request activity automatically
wakes exactly the repository-scoped role Agent without App mention or assignment matching, receives its terminal outcome
on GitHub, and does not loop. Human targeting and followed-chat routes remain independent. The two roles remain
independently configured and cannot select the same Agent. Agent-visible webhook attribution is GitHub/system, task-only
cards do not invent personnel context, and webhook content is never treated as authorization beyond the recipient-scoped
task capability and host GitHub permissions.

`FAIL`: a reproducible regression in authentication, tenant resolution, followed-chat/card delivery, automatic task or
wake routing, recipient-bound publication, self-output suppression, whole-request deduplication, or Context Reviewer
claim coverage.

`BLOCKED`: the isolated run cell cannot provision a disposable App/installation, webhook credential, bound entity, or
connected runtime needed by the selected observations.

`INCONCLUSIVE`: only internal logs or database state are available and the user-visible card/inbox or App-publication
behavior cannot be attributed to the tested ref.

## Evidence

Keep redacted request/response records, Settings copy captures, followed and automatic-task cards, relevant
inbox/session evidence, App comment evidence, and duplicate/invalid-signature outcomes. Never retain the webhook secret,
access tokens, private sessions, or full signed request headers.
