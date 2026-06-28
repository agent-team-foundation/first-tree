---
name: first-tree-welcome
version: 1.0.1
description: Use only when a First Tree onboarding system kickoff explicitly names first-tree-welcome, including production_scan growth kickoffs, or for First Tree onboarding welcome, intro, or value-first first-work chats. Do not use for tree setup kickoffs, ordinary chats, PR reviews, tree writes, or maintenance.
---

# First Tree Welcome

## Scope

Use this skill only when a First Tree system onboarding message explicitly asks
you to use `first-tree-welcome`, or when the chat is clearly the onboarding
welcome / intro / first work chat created by First Tree. Do not use it for tree
setup kickoffs, ordinary chats, PR reviews, tree writes, or maintenance work.

## Goal

Help the user feel First Tree's core value: an agent can work from their GitHub
code repo and their team's Context Tree. Guide any missing setup just enough to
unlock that value, then steer the welcome chat toward one small, useful,
verifiable task. In production_scan growth chats, produce a repo-grounded
launch-readiness report, steer toward one must-fix task, and preserve a Task
Brief. Heavy Context Tree setup runs in a separate chat.

## Priority Order

1. **Show real value from evidence.** Read available repo, local path, GitHub
   URL, or Context Tree context before claiming understanding.
2. **Complete only the setup needed for value.** GitHub App install, repo
   selection, and Context Tree binding are paths to useful work, not task
   options.
3. **Land on a small task.** When evidence supports it, ask the user to choose a
   bounded first task that can produce a clear result quickly.
4. **Keep tree work in its lane.** Mention tree setup briefly, then use or point
   to the separate tree setup chat for seeding or updating the Context Tree.

Do not pretend the user sent the kickoff. First Tree sent it.

## Read Setup State First

Before your first substantive reply, infer the onboarding state from the kickoff
message, runtime briefing, repo resources, Context Tree binding, and available
local files:

- role: admin, invitee, or unclear;
- kickoff kind: `intro`, `work`, `production_scan`, or `tree`;
- GitHub App: missing, installed, or unknown;
- code repo: selected/recommended, local path/URL provided, or none;
- Context Tree: no binding, newly bound empty tree, bound populated tree, or unknown;
- tree setup chat: already exists, explicitly promised by kickoff, or absent.

If state is unknown, say what is missing and ask for the smallest useful input.
Do not invent repo access, GitHub authorization, or tree readiness.

## Setup State Matrix

Apply rows from top to bottom; the first matching row wins. Earlier rows
protect lane, role, and executable setup boundaries. Later rows refine what
evidence to read and which first-task options to offer.

| Priority | State | What to do |
| --- | --- | --- |
| 1 | Tree kickoff chat | This is the heavy tree lane. Use `first-tree-seed`, `first-tree-read`, or `first-tree-write` as appropriate instead of this value-chat flow. |
| 2 | production_scan kickoff chat | Use the Production Scan Lane below: local-first repo access, no upfront GitHub App, a production-readiness report, 2-3 must-fix candidates, and a Task Brief after the user chooses. |
| 3 | Invitee on a not-ready team | Do not show admin setup, select repos, or create a duplicate tree. Offer a meet-the-agent / local-path path now and note that an admin finishes team setup. |
| 4 | No repo connected / intro chat | Ask for one local clone path or GitHub URL. Do not ask for GitHub authorization first. |
| 5 | Team repo/resource exists but local credentials cannot read it | State the exact read failure. Do not claim private repo contents. Ask for a local clone path, accessible URL, or credential setup. |
| 6 | Admin missing GitHub App for durable code access after local path/URL or repo evidence exists | Give value from available local path or accessible URL first. When durable team access is the blocker, use Setup Handoff to provide a stable deep link or durable fallback. |
| 7 | Admin has GitHub App but no selected/recommended repo | Explain that repo selection lets the agent work with code long-term. If any local path or URL is available, inspect it now; otherwise point to the product repo-selection surface using Setup Handoff. |
| 8 | Repo readable but Context Tree missing or empty | Give code-based value in this chat. Mention that the separate tree chat will build the team's shared memory; do not make tree setup a first-task option. |
| 9 | Repo readable and populated Context Tree readable | Read both, cite concrete evidence, then offer first-task options. Do not seed the tree. |
| 10 | Repo readable but tree state unknown | Give repo-based value; do not invent tree readiness. Mention the missing tree signal only if it affects durable value. |

Cloud onboarding owns one-click Context Tree repo bootstrap and org binding.
Agents may seed an empty bound tree or update a populated bound tree in the
correct tree chat, but must not silently create, bind, or duplicate team-wide
setup from the welcome chat.

## Setup Handoff

When useful work depends on a setup action the agent cannot perform, make the
handoff actionable without inventing UI details. Do not hand the user vague
navigation such as "go to the web console", and do not give brittle
click-by-click UI paths.

Before handing off:

1. Classify the current human as admin, invitee/member, or unclear. If the role
   is unclear, do not assume admin; say the action may require an organization
   admin and ask who should be involved.
2. Look for stable target data: console base URL, org/team slug, product deep
   link, GitHub App install URL, or GitHub App slug. Sources may include the
   kickoff message, runtime briefing, non-secret local config, product context,
   or `first-tree agent status` output. Use the channel-correct binary name from
   the runtime briefing. Do not expose tokens, secrets, or private keys.
3. If the human is an admin, give the most specific stable target available:
   product deep link first; GitHub install URL only when the install URL or App
   slug is known; otherwise the console base URL plus a durable fallback area
   such as Settings / Integrations. Do not guess org slugs, App slugs, or URLs.
4. If the human is not an admin, do not send them into an admin-only setup
   surface. If the responsible admin is known, involve them through the host
   collaboration mechanism; otherwise ask who should be brought in.
5. If no stable target can be found, say exactly what is missing and ask for the
   smallest useful input, such as the console URL, org/team, or admin contact,
   while continuing with local-path or URL-based value when possible.

After a setup handoff completes or new access appears, re-read setup state and
continue this value chat from the first matching Setup State Matrix row. Do not
treat setup handoff as a mode switch: heavy tree seeding or updating stays in a
separate tree kickoff chat, while this chat uses newly readable repo or tree
context to offer or continue useful first-task work.

Do not hardcode exact button labels, avatar menus, tab names, or step-by-step
click paths in this skill. Product navigation changes faster than shipped
skills; deep links plus durable fallback areas are safer than precise prose
that can drift.

## Production Scan Lane

Use this lane when the kickoff kind is `production_scan` or the kickoff says
the user came from the production-scan growth path.

This is still an onboarding first chat, not a long-term standalone skill. The
goal is to help the user feel First Tree's repo-thread value quickly through a
launch-readiness audit:

1. Prefer local-first repo access through the connected computer, existing
   `gh` auth, git credentials, or a local clone. Do not require GitHub App
   installation before reading the repo.
2. Read enough concrete repo evidence before making recommendations: README,
   manifests, build/test config, auth/data boundaries, dependency manifests,
   deploy/runtime config, observability hooks, TODOs, recent failures, or
   high-risk code paths.
3. Produce a concise production-readiness report. Prioritize
   security-weighted launch blockers over generic code quality observations.
   Useful dimensions include security, secrets/config, auth/data boundaries,
   tests/CI, deploy/runtime, observability, dependencies, and docs/onboarding.
4. Offer 2-3 must-fix task candidates from the report. Each candidate should
   include why it matters, evidence, likely scope, key files, first
   verification step, and how it could become a PR, follow-up thread, or
   teammate handoff.
5. Ask the user to choose one candidate before broad implementation work.
6. After the user chooses, update the chat description with a concise Task
   Brief: goal, scope, key files, plan, current status, and next step.

Bring up GitHub App only when the chosen task needs durable GitHub-side
capabilities such as opening a PR, commenting on a PR/issue, following GitHub
events, or long-term team repo integration. Explain the specific capability
needed; do not ask for abstract integration just in case.

Production scan task candidates should be more durable than ordinary
fast-value tasks: they should be worth resuming, reviewing, handing off, or
turning into a PR. If the repo evidence is too thin, start with a read-only
orientation/report task instead of inventing implementation work.

## First Response Contract

Your first substantive reply in a welcome / intro / work chat must:

1. State specific understanding from evidence: stack, entry points, important
   modules, tests, TODOs, conventions, risks, repo shape, or team context you
   actually observed.
2. Name at most one missing setup step if it blocks durable value, and explain
   why it matters in product terms.
3. If enough evidence exists, ask the user to choose a first task using the
   host's tracked request / ask primitive when available. In First Tree CLI, use
   `first-tree chat ask <human> ... --options ...`; if the harness has no
   request primitive, send a normal reply with 2-3 options and explicitly accept
   free text.
4. Accept free text as another valid answer.
5. Mention Context Tree at most once, with a plain gloss such as "your team's
   shared memory", unless this is the tree setup chat.

## Choosing Fast-Value Tasks

Pick tasks that help the user feel value quickly. A good welcome task is:

- Evidence-backed: tied to a file, module, TODO, test gap, dependency, or behavior you observed.
- Bounded: small enough for a first pass in one short work session.
- Low-risk: avoids large architecture changes, migrations, security-sensitive changes, or broad refactors.
- Verifiable: has a clear check, test, lint, screenshot, doc diff, or manual acceptance signal.
- Useful to the user: improves understanding, confidence, correctness, onboarding, or a real workflow.
- Decision-light: does not require unresolved product strategy or team policy before starting.

Prefer tasks like:

- Add or repair a narrow test around a visible untested flow.
- Explain the architecture around a concrete entry point.
- Trace one user flow end-to-end.
- Fix a small TODO or obvious error-handling gap.
- Create a concise setup/runbook from the actual repo commands.
- Map the data model or API surface when that is the clearest first value.

Avoid tasks like:

- "Refactor the codebase" or other broad work.
- "Build the Context Tree" as a task option in the value chat.
- "Install GitHub App", "select a repo", or "set up the tree" as task options.
- Vague options such as "improve code quality".
- Claims of bugs without evidence.
- Work that needs new credentials, production access, or irreversible actions before the user explicitly agrees.

If the repo evidence is thin, choose read-only orientation tasks instead of inventing implementation work.

## Request Decision Rule

Send a tracked request only when you can offer two or three real task options.
Use concise option labels and one-sentence descriptions. Do **not** include a
`Skip for now` option: the First Tree web ask UI already provides a footer Skip.
Make clear the user can type free text for another task.

If there is only one responsible next step, recommend it in a normal reply and
ask for confirmation. If setup blocks all useful code work, ask for the one
missing input or guide the product setup step instead of faking task options.

Example shape:

```text
I found a Next.js app with checkout code in `app/checkout/` and no nearby tests. I also noticed `middleware/auth.ts` has a TODO for expired sessions.

What should we do first?
- Add checkout tests: Cover the happy path and one failure case.
- Fix expired-session handling: Turn the TODO into concrete behavior and tests.
- Map the app architecture: Give you a short guide to routes, data, and auth.

You can also type another task.
```

## No Repo Yet

If First Tree says no repo is connected:

1. Do not ask for GitHub App authorization first.
2. Ask for either a local clone path or a GitHub URL.
3. If they provide a local path, inspect it on the machine and give the same evidence-backed task request.
4. If they provide a GitHub URL, use local git/gh credentials when available; if access fails, explain the exact next step.
5. Only after giving value should you ask whether this should become long-term team code.

Long-term team setup, GitHub App authorization, or `gh repo create` all require explicit user confirmation. Use a tracked ask for those confirmations.

## Tree Chat Handoff

If a separate Context Tree setup chat exists or is about to be created, keep
this value chat focused on helping the user start work. You may say one short
sentence such as:

"I’ll also let the separate setup chat build your team’s Context Tree, the shared memory future agents use."

Do not create another tree setup chat when one already exists. Do not run a
heavy tree seed in this chat unless First Tree explicitly put you in the tree
setup chat. In a tree setup chat, use `first-tree-seed`, `first-tree-read`, or
`first-tree-write` as appropriate.

## Role Guardrails

- Admins may be guided through GitHub App, repo selection, and Context Tree
  setup surfaces.
- Invitees must not be asked to select team repos, install the team's GitHub
  App, create a duplicate Context Tree, or mutate org-wide setup.
- Private repo access depends on the member's local host credentials. Do not
  promise access to named private repos until reads actually succeed.
- Authorization, repo creation, pushes, PR creation, and destructive actions
  require explicit user confirmation.

## Hard Rules

- Read before claiming understanding.
- Use concrete evidence, not generic onboarding prose.
- Treat setup as a path to value, not as a first-task option.
- Give 2-3 bounded first-task options only when evidence supports them.
- In `production_scan`, make those options must-fix launch-readiness candidates
  and update a Task Brief after the user chooses.
- Do not put `Skip for now` in request options; rely on the web ask footer Skip.
- Keep the menu as a request when the user is choosing between real tasks.
- Do not block the value chat on Context Tree setup.
- Do not perform authorization, repo creation, pushes, or PR creation without explicit consent.
- Do not use retired onboarding skill names such as `first-tree-guide`, `first-tree-onboarding`, or `first-tree-kickoff`.
