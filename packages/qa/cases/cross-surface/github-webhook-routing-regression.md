---
id: github-webhook-routing-regression
description: Verify signed GitHub App webhooks reach followed chats and route authorized App requests to the repository-scoped Agent role.
areas: [cross-surface]
surfaces: [server, github, client, web]
---

# GitHub Webhook Routing Regression

## Goal

Verify the live GitHub App ingress-to-chat path across its real boundaries: HMAC authentication, installation-to-Team
resolution, normalized event processing, followed-chat routing, card persistence, and inbox wake delivery. Product tests
own deterministic payload and failure matrices; this case checks that the assembled deployment still wires those parts
together without a GitHub-specific post-delivery branch.

## Preconditions

- Use an isolated Docker plus temporary-worktree QA run cell.
- Configure a GitHub App webhook secret and a bound, active installation for the test Team, with Issues and pull
  requests read/write permissions. Use a disposable repository and test identities; do not point a production App at
  the run cell.
- Create a chat with an eligible human/delegate pair and follow one disposable issue or pull request in that chat.
- Select different active, organization-visible managed Agents for Context Reviewer and GitHub Task Agent. Use Settings
  → Getting Started for Context Reviewer and Settings → Integrations → GitHub → Task routing for GitHub Task Agent; confirm each
  surface rejects an assignment that would reuse the other role's Agent. Leave Automatic Review off for the first non-Context
  repository observations so ordinary delegation is proven independently from Context Review.
- Bind the Team's Context Tree to one GitHub repository. Use a second disposable GitHub repository for GitHub Task Agent
  observations. A GitLab Context Tree binding can be used as an additional negative control.
- Keep a matching client runtime connected if the plan includes observing the agent wake. A missing provider credential
  may block the later model turn, but it must not prevent card and inbox evidence.

## Operate and Observe

- Deliver a valid HMAC-signed webhook for the followed entity with a stable `X-GitHub-Delivery` value. Observe one GitHub
  card in the followed chat and, for an explicit target, the expected delegate inbox/session wake. Inspect the delegate's
  assembled turn input and confirm both a current webhook card and a card carried as preceding silent context use
  `[From: GitHub · type=system ...]`, never the representative human carrier.
- Redeliver the same signed body with the same stable delivery id. Observe a successful deduplicated response and no
  second card or wake.
- Deliver an equivalent supported event without `X-GitHub-Delivery`. Confirm it is accepted without creating a
  `processed_events` claim. If the event is repeated, treat repeated side effects as the documented weak-reliability
  baseline rather than an exactly-once promise.
- Send a request with an invalid signature and confirm it is rejected before installation lookup, claim, card, or wake.
- In the non-Context repository, enter the exact GitHub App slug as literal mention text from an `OWNER`, `MEMBER`, or
  `COLLABORATOR` Issue or PR author/commenter. Do not require GitHub's native mention picker: an ordinary GitHub App bot is
  not currently selectable there. Cover the structured App-assignee contract only with a correctly signed synthetic
  webhook payload or programmable provider mock; do not list assigning the ordinary App bot in the GitHub UI as a live
  PASS prerequisite. Confirm each supported request creates or reuses one entity chat for the selected GitHub Task Agent, wakes
  that exact Agent, and persists
  `teamAgentTask: { agentUuid: "<selected UUID>", runId: "<server run>" }` on both the card and message metadata.
  Repeat a text mention from an untrusted public contributor and confirm no App-directed
  attention line, task marker, or Agent wake is created; normal followed-chat delivery must remain intact. Treat the
  structured assignee event as trusted independently of textual `author_association`.
- Repeat the non-Context request where the GitHub actor already maps the entity to a different delegate. Confirm the
  selected GitHub Task Agent is added as a chat participant and is woken, while the existing delegate remains unwoken and does
  not receive an executable task marker. Repeat with unrelated attention lines in the same chat and confirm task
  identity remains recipient-scoped.
- In the bound GitHub Context Tree repository, make the same authorized App request and confirm only the Context Reviewer
  is targeted. Confirm repository matching tolerates canonical URL spelling, case, and `.git` differences. Verify the
  second GitHub repository still targets GitHub Task Agent, and that a GitLab Context Tree binding does not classify any GitHub
  repository as the Context repository.
- Remove or invalidate each role selection in turn and confirm only its App-directed attention line is skipped; existing
  human targets and subscriptions still receive ordinary cards. Remove the verified App slug/login and confirm Settings
  → Integrations → GitHub → Task routing exposes a GitHub Task Agent readiness blocker and assignment fails closed instead
  of silently degrading.
- Let the GitHub Task Agent finish one App-targeted task. Confirm it inspects and acts through the normal host GitHub identity,
  then uses `first-tree github reply --run <runId> --body-file <path>` for the terminal outcome. Observe an App-authored
  comment on the fixed originating Issue or PR; its hidden run marker is present, the visible body does not mention the
  App, and no delegated loop occurs. A First Tree chat-only result or a terminal host-identity comment is incomplete.
  Retry the identical payload and confirm the same comment is returned without another GitHub write; race two identical
  submissions and confirm only one POST occurs, the in-flight loser may receive a stable unknown result from read-only
  reconciliation, and a later retry reads the winner's result. Change the payload and confirm rejection. Simulate an
  unknown GitHub write, then confirm retry
  reconciles the App actor, hidden run marker, and exact body before returning rather than blindly creating another
  comment. Zero matches, duplicate exact matches, and list failure must all remain unknown with no second POST.
- Attempt publication from a different Agent, client, runtime session, chat, repository-scoped role assignment, inactive
  membership, and spoofed user-authored `githubTask*` metadata. Confirm each fails before GitHub mutation. Confirm a reply
  that mentions the App is rejected. Historical boolean/no-run markers remain renderable but cannot publish; App-targeted
  Discussion and commit events return `GITHUB_TASK_REPLY_ENTITY_UNSUPPORTED`, while a missing accepted write grant returns
  `GITHUB_TASK_REPLY_APP_PERMISSION_REQUIRED`. Both omit the task run and GitHub mutation while independent followed lines
  remain delivered.
- Redeliver an App mention with a fresh delivery id on the same entity. Confirm the existing GitHub Task Agent chat/attention
  line is reused rather than creating another chat.
- Enable Context Reviewer and include one supported Context Tree PR trigger. Confirm it reuses its dedicated reviewer
  chat and retains trusted review publication authority only for that path. The ordinary App-target card must not gain
  trusted App review or merge authority.

## Expected Result

`PASS`: signed events resolve through the bound installation, reach the expected chat and wake path, stable delivery ids
deduplicate the whole request, missing delivery ids do not claim, invalid signatures have no side effects, and optional
Context Reviewer behavior remains dedicated and claim-covered. Authorized literal App mentions in the live slice and
signed synthetic structured-assignment events wake exactly the repository-scoped role Agent, receive their outcome on
GitHub, and do not loop; untrusted public text requests do not execute. The two roles remain independently configured and
cannot select the same Agent. Agent-visible webhook attribution is GitHub/system while ordinary human target,
subscription, and participant behavior remains intact.

`FAIL`: a reproducible regression in authentication, tenant resolution, followed-chat/card delivery, wake routing,
whole-request deduplication, or Context Reviewer claim coverage.

`BLOCKED`: the isolated run cell cannot provision a disposable App/installation, webhook credential, bound entity, or
connected runtime needed by the selected observations.

`INCONCLUSIVE`: only internal logs or database state are available and the user-visible card/inbox behavior cannot be
attributed to the tested ref.

## Evidence

Keep redacted request/response records, the followed-chat card, relevant inbox/session evidence, and the duplicate and
invalid-signature outcomes. Never retain the webhook secret, access tokens, or full signed request headers.
