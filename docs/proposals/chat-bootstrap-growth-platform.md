# Proposal: Chat Bootstrap Core and Growth Activation Foundation

Status: Draft for architecture review

## Summary

First Tree is currently evolving two related areas:

- Onboarding is being simplified into a value-first path: connect a computer,
  create or reuse a user-managed agent, then open the first useful chat.
- Growth is starting to form a repeatable campaign platform through quickstart
  scan flows, where an external entry point carries a campaign and repository
  intent into a guided agent setup and scan chat.

Both areas need the same lower-level capability: create or reuse a normal chat
idempotently, send exactly one server-authored bootstrap message, and notify the
target agent. Today that capability still lives under the historical onboarding
kickoff naming and API shape. The implementation is useful and mostly correct,
but the ownership and naming are now misleading.

This proposal recommends extracting that lower-level capability as a small
`chatBootstrapService`, keeping chat as a single product model, removing global
intent presets from the core, and letting domain services plus skills define
what the agent should do.

## Background

### Onboarding direction

The current onboarding direction is correct: the first-run path should prove
value quickly. The user should not need to complete GitHub App installation,
repository authorization, or Context Tree setup before seeing an agent work.

The current onboarding flow already reflects this direction:

- Connect the user's computer.
- Create or reuse the user's personal agent in the selected org.
- Start a chat with that agent.
- Mark onboarding complete only after the start-chat path succeeds.

GitHub App installation, repository selection, and Context Tree setup should
remain available, but they should be task-time, settings-time, or
post-onboarding capabilities. They should not be hard prerequisites for the
main onboarding success path.

### Growth and quickstart direction

The quickstart scan campaign is the first concrete growth loop. Its internal
architecture flow is:

1. An external landing page generates a quickstart handoff URL with a campaign
   slug and target repository URL.
2. The web app enters `/quickstart` and parses the handoff.
3. The parser accepts only known campaign slugs and normalized GitHub
   repository URLs.
4. If the user is logged out, the login round trip preserves the quickstart
   intent through a safe redirect.
5. The quickstart page reuses the existing computer-connection flow to mint a
   connect token and wait for the local client or daemon to register.
6. After the client reports runtime capabilities, the web app selects a usable
   runtime provider.
7. The web app creates or reuses the user's private agent in the current org.
8. When the agent is online, the web app starts a campaign chat with the target
   agent.
9. Before the bootstrap message is sent, the server provisions and binds the
   server-owned scan skill for the campaign.
10. The server idempotently creates or reuses the chat and sends one bootstrap
    message.
11. The agent runtime uses the bound skill and bootstrap content to run the
    scan, produce a report, offer a concrete deliverable, and ask for the next
    conversion action.

This flow already contains the primitives a reusable growth platform needs:
external intent handoff, login continuation, device connection, agent
provisioning, campaign-specific skill binding, first-value chat creation, and
conversion prompts.

The problem is not the product direction. The problem is that the shared
infrastructure for the chat bootstrap still lives in onboarding-specific
surfaces.

## Current architecture issues

### 1. Onboarding kickoff is now a generic bootstrap path

The route `POST /me/onboarding/kickoff`, the service `kickoffOnboarding`, and
the column `chats.onboarding_kickoff_key` are named as onboarding concepts.
However, the same path is now also used by quickstart growth campaigns.

The underlying operation is not onboarding-specific anymore. It is:

- create or reuse a chat by an idempotency key;
- send exactly one server-authored bootstrap message;
- optionally perform a pre-send side effect;
- notify recipients.

Keeping this under onboarding naming makes future growth, Context Tree, and
integration-triggered flows depend on an unrelated product lifecycle.

### 2. The core path is accumulating business intent

The current kickoff shape includes a `kind` concept such as intro, work, and
tree, and quickstart adds campaign data to the same path. This encourages the
core service to grow a global vocabulary of business intents.

That conflicts with the product model: First Tree should have one chat model.
The chat core should not know whether a bootstrap is for onboarding, a scan,
Context Tree setup, or a future GitHub review. Those intents belong to domain
services and skills.

### 3. Idempotency keys need stronger domain ownership

The current key shape is suitable for onboarding, but it is not sufficient for
long-term growth campaigns. A campaign may be run multiple times for the same
user and agent against different repositories. The key must include the domain
identity that makes a bootstrap unique, such as a canonical repository key or a
campaign run id.

The core service should not construct this key from a fixed set of global
fields. The domain service should provide the key because only the domain knows
the uniqueness boundary.

### 4. Campaign behavior is split across web and server

Today the web campaign registry owns the first-chat bootstrap copy while the
server owns the campaign scan skill. This split is workable for the first
campaigns, but it does not scale well.

For a reusable growth platform, the server should own the campaign behavior
that affects execution:

- campaign slug validation;
- scan skill payload and version;
- bootstrap content;
- conversion policy;
- event names and properties.

The web app should parse and carry the handoff, render setup state, and call the
campaign API. It should not be the source of truth for agent behavior.

### 5. Growth events do not yet have a product fact table

Onboarding and quickstart events are currently spread across server logs, GA4,
message metadata, and session events. Those are useful for diagnostics and
external analytics, but they are not a stable product fact source.

Growth needs queryable, append-only product events in Postgres so campaign
funnels can be analyzed without reverse-engineering logs or chat metadata.

### 6. Context Tree setup still has onboarding namespace residue

Context Tree setup recovery is an org-level capability. It should not remain
long-term under `/me/onboarding/*`. It can still reuse the same chat bootstrap
primitive, but its status and recovery APIs should live under Context Tree or
org setup ownership.

## Goals

### Onboarding goals

- Keep onboarding focused on the membership lifecycle.
- Preserve the value-first path: connect computer, create or reuse agent, start
  chat.
- Complete onboarding only after the start-chat path succeeds.
- Keep GitHub App and Context Tree setup outside the critical first-run path.
- Remove the need for growth and Context Tree flows to call onboarding-named
  bootstrap APIs.

### Growth platform goals

- Support multiple reusable campaigns, such as production scan, agent readiness,
  security scan, migration audit, and future repository-specific assessments.
- Support repeat runs across different repositories without idempotency
  collisions.
- Keep campaign execution behavior server-owned.
- Record product events in a durable, queryable fact table.
- Reuse existing computer connection and agent provisioning primitives without
  duplicating setup logic.

### Platform goals

- Keep one chat model.
- Do not introduce global chat kinds or chat types.
- Do not use message metadata as a business orchestration layer.
- Let skills and domain services define agent intent.
- Make the shared chat bootstrap primitive small, idempotent, and reusable.

## Proposed architecture

### 1. Extract `chatBootstrapService`

Create an internal service that owns the generic idempotent chat-bootstrap
operation.

Proposed input:

```ts
type ChatBootstrapInput = {
  organizationId: string;
  creatorAgentId: string;
  participantAgentIds: string[];
  bootstrapKey: string;
  topic: string;
  bootstrapContent: string;
};
```

The service guarantees:

- a non-null `bootstrapKey` maps to at most one chat;
- the bootstrap message is sent at most once for that chat;
- concurrent retries serialize safely;
- recipient notification happens only when a message is actually sent.

The service does not know:

- onboarding completion;
- campaign names;
- Context Tree state;
- GitHub App state;
- skill selection;
- growth event names;
- global chat kinds.

### 2. Keep business intent in domain services and skills

The caller prepares the business context, binds required skills or resources,
builds the bootstrap content, and writes domain events.

Suggested domain services:

#### `onboardingStartChatService`

Responsibilities:

- resolve the caller's membership and human agent;
- resolve the target agent;
- prepare onboarding welcome/bootstrap content;
- call `chatBootstrapService`;
- mark `members.onboarding_completed_at` and suppression fields only after the
  chat bootstrap succeeds.

#### `quickstartCampaignService`

Responsibilities:

- validate the campaign slug and target repository;
- canonicalize the repository identity;
- create or reuse the target agent through existing agent setup primitives;
- ensure the server-owned campaign scan skill is bound to the target agent;
- generate a campaign bootstrap key that includes the repository or run
  identity;
- call `chatBootstrapService`;
- write growth activation events.

#### `contextTreeSetupService`

Responsibilities:

- verify GitHub App and Context Tree prerequisites;
- register source repositories when needed;
- create or adopt the Context Tree repo when appropriate;
- call `chatBootstrapService` to start the setup chat;
- expose setup status and recovery under Context Tree ownership, not
  onboarding ownership.

### 3. Make `bootstrapKey` domain-owned

The core service should accept a key. It should not build one from global
fields.

Examples:

```txt
onboarding:<membershipId>:<agentId>:welcome
quickstart:<campaignSlug>:<repoCanonicalKey>:<memberId>:<agentId>
context-tree-setup:<orgId>:<agentId>:<treeRepoCanonicalKey>
github-pr-review:<installationId>:<repoCanonicalKey>:<prNumber>
```

The important property is not the exact string format. The important property
is that the domain owns the uniqueness boundary.

### 4. Avoid global `kind`

Do not add a new global `kind` enum to the core.

The previous `intro | work | tree` vocabulary may remain in compatibility
wrappers while routes are migrated, but it should not be the long-term core
model. If a domain needs category labels for analytics or recovery, it should
write domain events or domain state.

### 5. Keep metadata minimal

Do not introduce a new business metadata contract for chat bootstrap.

Short term, keep the existing trusted system marker for compatibility. Medium
term, rename it from an onboarding-specific value to a generic bootstrap marker
only after all readers are migrated.

Message metadata should mark server trust and compatibility only. It should not
become the source of truth for campaign, onboarding, or Context Tree workflow
state.

### 6. Introduce `activation_events`

Add an append-only product event table for onboarding and growth.

Suggested shape:

```txt
activation_events
- id
- user_id
- member_id
- organization_id
- flow
- event
- properties jsonb
- created_at
```

Examples:

- `onboarding_started`
- `onboarding_agent_created`
- `onboarding_chat_started`
- `quickstart_started`
- `campaign_skill_bound`
- `campaign_chat_started`
- `campaign_ask_shown`
- `campaign_ask_accepted`
- `context_tree_setup_started`
- `context_tree_setup_completed`

This should complement, not replace, GA4 and operational logs. GA4 remains
external analytics. Logs remain diagnostics. `activation_events` is the product
fact source.

`activation_runs` can be deferred until the product needs cross-tab,
cross-device, or long-running campaign recovery. Avoid introducing a workflow
engine before that requirement is concrete.

## Migration plan

### Phase 0: Extract without behavior change

- Add `chatBootstrapService`.
- Move the core idempotent chat creation and bootstrap send logic into it.
- Keep `kickoffOnboarding` as a thin compatibility wrapper.
- Keep existing route behavior.
- Update comments around `chats.onboarding_kickoff_key` to mark it as a legacy
  bootstrap key name.

### Phase 1: Move callers to domain ownership

- Add an onboarding start-chat domain service.
- Add a quickstart campaign start-chat domain service.
- Move campaign bootstrap generation to the server.
- Update quickstart to call the campaign domain API instead of the onboarding
  API wrapper.
- Ensure quickstart bootstrap keys include repository or run identity.
- Keep Context Tree setup on the current path until the bootstrap core is
  stable.

### Phase 2: Add growth facts

- Add `activation_events`.
- Write events from onboarding and quickstart services.
- Keep GA4 and logs as secondary analytics and diagnostics.
- Start building campaign funnel queries from Postgres events.

### Phase 3: Rename storage and remove legacy surfaces

- Add `chats.bootstrap_key`.
- Dual-write old and new key fields.
- Backfill existing rows.
- Cut reads to `bootstrap_key`.
- Retire `onboarding_kickoff_key` usage.
- Move Context Tree setup status out of onboarding namespace.
- Remove legacy kickoff wrappers once all callers are migrated.

## Non-goals

- Do not add chat types.
- Do not add a global chat `kind` system.
- Do not build a generic workflow engine in this proposal.
- Do not make message metadata the orchestration state store.
- Do not move GitHub App installation or Context Tree setup back into the
  critical onboarding path.

## Review questions

1. Should `chatBootstrapService` become the shared internal primitive for
   server-authored bootstrap chats?
2. Do we agree that chat remains a single model, with intent defined by skills
   and domain services rather than global kinds?
3. Should quickstart campaign behavior become server-owned before adding more
   campaigns?
4. Is `activation_events` the right first step for a reusable growth platform,
   with `activation_runs` deferred until recovery requirements are concrete?
5. Should we keep the existing DB field temporarily and migrate to
   `bootstrap_key` in a later phase?

## Expected outcome

After this refactor, onboarding remains simple, growth gains a reusable
foundation, and future Context Tree or integration-triggered flows can reuse a
small idempotent chat bootstrap primitive without depending on onboarding
semantics.
