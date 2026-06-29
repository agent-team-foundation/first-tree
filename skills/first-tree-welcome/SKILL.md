---
name: first-tree-welcome
version: 1.0.3
description: Use only when a First Tree onboarding start-chat system message explicitly names first-tree-welcome, or for First Tree onboarding welcome, intro, or value-first first-work chats. Do not use for tree setup chats, ordinary chats, PR reviews, tree writes, or maintenance.
---

# First Tree Welcome

## Scope

Use this skill only when a First Tree onboarding start-chat system message
explicitly asks you to use `first-tree-welcome`, or when the chat is clearly
the onboarding welcome / intro / first work chat created by First Tree. Do not
use it for tree setup chats, ordinary chats, PR reviews, tree writes, or
maintenance work.

## Goal

Help the user feel First Tree's core value: an agent can work from a local
folder, a GitHub URL via host `gh`, an already-connected repo, and when
available the team's Context Tree. Guide any missing setup just enough to
unlock current value, then steer the welcome chat toward one small, useful,
verifiable task. Heavy Context Tree setup runs in a separate chat.

Setup is pulled in by the task, not pushed for its own sake. Value comes
first; when the real work the user chose genuinely needs a setup step — host
`gh` is missing, a private repo needs the GitHub App, the task truly needs the
team's Context Tree — name that blocker, guide that one step to completion,
then continue the task. Never lead with setup, and never make setup the task.

## Priority Order

1. **Show real value from evidence.** Read available repo, local path, GitHub
   URL, or Context Tree context before claiming understanding.
2. **Complete only the setup needed for value.** Prefer local path and host
   `gh` for ordinary GitHub work. GitHub App install, repo authorization, and
   Context Tree binding are platform setup paths, not task options (see Setup
   Handoff for when and how to raise one).
3. **Land on a small task.** When evidence supports it, ask the user to choose a
   bounded first task that can produce a clear result quickly.
4. **Keep tree work in its lane.** Mention tree setup briefly, then use or point
   to the separate tree setup chat for seeding or updating the Context Tree.

Do not pretend the user sent the start-chat system message. First Tree sent it.

## Read Setup State First

Before your first substantive reply, infer the onboarding state from the
start-chat system message, runtime briefing, repo resources, Context Tree
binding, and available local files:

- role: admin, invitee, or unclear;
- start-chat kind: `intro`, `work`, or `tree`;
- GitHub App: missing, installed, or unknown;
- code repo: selected/recommended, local path/URL provided, or none;
- Context Tree: no binding, newly bound empty tree, bound populated tree, or unknown;
- tree setup chat: already exists, explicitly promised by start-chat, or absent.

If state is unknown, say what is missing and ask for the smallest useful input.
Do not invent repo access, GitHub authorization, or tree readiness.

## Setup State Matrix

Apply rows from top to bottom; the first matching row wins. Earlier rows
protect lane, role, and executable setup boundaries. Later rows refine what
evidence to read and which first-task options to offer. The last row is an
explicit catch-all, so every state has a defined action — never fall through
silently.

Role gates only admin-only setup, not value. If the role is unclear, give value
from whatever evidence is readable, but do not assume admin: for any admin-only
setup step, say it may require an organization admin and ask who should be
involved (see Setup Handoff) rather than walking the user into an admin surface.

| Priority | State | What to do |
| --- | --- | --- |
| 1 | Tree setup chat | This is the heavy tree lane. Use `first-tree-seed`, `first-tree-read`, or `first-tree-write` as appropriate instead of this value-chat flow. |
| 2 | Invitee on a not-ready team | Do not show admin setup, select repos, or create a duplicate tree. Offer a meet-the-agent / local-path path now and note that an admin finishes team setup. |
| 3 | Invitee on a ready team (recommended repo and/or populated tree available) | Give value from the team's repo and tree like a normal work chat, citing concrete evidence, and offer bounded first-task options. Keep invitee guardrails: do not push admin-only setup (GitHub App, repo selection, tree build); an admin owns those. |
| 4 | No repo connected / intro chat | Ask for one local clone path or GitHub URL. For GitHub URLs, try host `gh` / local credentials first. Do not ask for GitHub authorization first. |
| 5 | Team repo/resource exists but local credentials cannot read it | State the exact read failure. Do not claim private repo contents. Ask for a local clone path, accessible URL, or credential setup. |
| 6 | Admin missing GitHub App for durable platform access after local path/URL or repo evidence exists | Give value from available local path or accessible URL first. When follow, webhook events, team repo resources, or Context Tree setup is the blocker, use Setup Handoff to provide a stable deep link or durable fallback. |
| 7 | Admin has GitHub App but no selected/recommended repo | Explain that repo selection lets the agent work with code long-term. If any local path or URL is available, inspect it now; otherwise point to the product repo-selection surface using Setup Handoff. |
| 8 | Repo readable but Context Tree missing or empty | Give code-based value in this chat. Mention that the separate tree chat will build the team's shared memory; do not make tree setup a first-task option. |
| 9 | Repo readable and populated Context Tree readable | Read both, cite concrete evidence, then offer first-task options. Do not seed the tree. |
| 10 | Repo readable but tree state unknown | Give repo-based value; do not invent tree readiness. Mention the missing tree signal only if it affects durable value. |
| 11 | Any other state (catch-all) | Give evidence-backed value from whatever is readable; do not invent repo access or tree readiness. If nothing is actionable yet, ask for the smallest useful input (local path, accessible URL, or the one missing signal). |

Cloud onboarding owns one-click Context Tree repo bootstrap and org binding.
Agents may seed an empty bound tree or update a populated bound tree in the
correct tree chat, but must not silently create, bind, or duplicate team-wide
setup from the welcome chat.

## Setup Handoff

When useful work depends on a setup action the agent cannot perform, make the
handoff actionable without inventing UI details. Do not hand the user vague
navigation such as "go to the web console", and do not give brittle
click-by-click UI paths.

Let the task decide whether to raise a setup step, as an explicit branch:

- If the chosen task can produce its result without the setup step, do not raise
  it yet.
- If the task is genuinely blocked, or clearly worse, without it, name the
  blocker, guide that one step to completion, then continue the task.

Do not raise setup as an opening menu. When you do raise it, carry it through to
completion: a step the task needs should not be mentioned once and dropped. If
the user would rather not set it up now, keep doing the parts of the task that
work without it, and raise it again when the task next needs it. After it
completes, say briefly what it unlocked and what, if anything, is still gated.

Before handing off:

1. Classify the current human as admin, invitee/member, or unclear. If the role
   is unclear, do not assume admin; say the action may require an organization
   admin and ask who should be involved.
2. Look for stable target data: console base URL, org/team slug, product deep
   link, GitHub App install URL, or GitHub App slug. Sources may include the
   start-chat system message, runtime briefing, non-secret local config, product context,
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
separate tree setup chat, while this chat uses newly readable repo or tree
context to offer or continue useful first-task work.

Do not hardcode exact button labels, avatar menus, tab names, or step-by-step
click paths in this skill. Product navigation changes faster than shipped
skills; deep links plus durable fallback areas are safer than precise prose
that can drift.

## First Response Contract

Your first substantive reply depends on whether you already have evidence to
read:

**A. No project yet** — the default onboarding first chat: no repo connected,
no local path, and no GitHub URL given. Your first result is to ask the user
for the project — a local folder path or a GitHub URL — without faking
understanding. If they share a GitHub URL, use host `gh` first. This ask is a
legitimate first result, not a failure; the evidence-backed contract in B
applies to your next reply, once a project exists.

**B. Evidence available** — a repo is connected, or the user has given a local
path or URL. Your first substantive reply must:

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

- Verify or explain recent changes when the repo is on a feature branch or has uncommitted / unpushed work — often the most relevant first value.
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

## Doing the First Task

Offer the first-task options and wait for the user to pick; do not modify the
repo before they choose. Once the user picks a task, the onboarding payoff is
that they *see* it actually work. Finish it the way the task's own check defines
done:

- Run the verification the task implies — a test, a lint or type-check, a
  `browse` screenshot, a visible output, or a doc diff — and show the result.
  Onboarding succeeds when the user sees the task genuinely done, not when you
  report it done.
- Do not say a task is finished, or that a change "should work", without that
  evidence. If you could not verify, say so plainly and name what is left.
- Keep the change minimal and scoped to the task; do not refactor adjacent code
  on a first task.
- If you are stuck after a couple of honest attempts, say so and offer the next
  option rather than thrashing.

## Request Decision Rule

Send a tracked request only when you can offer two or three real task options.
Use concise option labels and one-sentence descriptions. Do **not** include a
`Skip for now` option: the First Tree web ask UI already provides a footer Skip.
Make clear the user can type free text for another task.

If there is only one responsible next step, recommend it in a normal reply and
ask for confirmation. If setup blocks all useful repo work, ask for the one
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
4. If they provide a GitHub URL, use host `gh` or local git credentials when available.
5. If `gh` is missing, unauthenticated, or lacks access, explain that exact gap and ask for the narrowest recovery: local clone path, GitHub CLI install, or `gh auth login` / account access.
6. Only after giving value should you ask whether this should become long-term team code.

Long-term team setup, GitHub App authorization, repo authorization, Context
Tree creation/binding, or `gh repo create` all require explicit user
confirmation. Use a tracked ask for those confirmations. If the user is not an
admin, explain that those are admin-owned setup actions and continue with local
path / host `gh` when possible.

## Tree Chat Handoff

If a separate Context Tree setup chat exists or is about to be created, keep
this value chat focused on helping the user start work. You may say one short
sentence such as:

"I’ll also let the separate setup chat build your team’s Context Tree, the shared memory future agents use."

Do not create another tree setup chat when one already exists. Do not run a
heavy tree seed in this chat unless First Tree explicitly put you in the tree
setup chat. In a tree setup chat, use `first-tree-seed`, `first-tree-read`, or
`first-tree-write` as appropriate.

If the task the user chose genuinely needs the team's Context Tree — for
example it depends on a decision or convention only the tree records — it is
fine to guide them, with their consent, to build or connect it as the step that
unblocks that task (via Setup Handoff). That is different from making tree setup
the first task, which you should not do, and from running a heavy seed here,
which stays in the tree setup chat.

Once the first task is done and the user has felt the value, and if this human
is an admin, you can be more proactive about the Context Tree even when no task
forced it: explain that building it lets every future agent and teammate start
from the team's shared memory instead of cold, and offer to kick off the
separate tree setup chat. For an invitee or member, do not push tree build; note
that an admin owns it (per Role Guardrails). Before that first value moment,
stay demand-driven and do not push it.

## Role Guardrails

- Admins may be guided through GitHub App, repo selection, and Context Tree
  setup surfaces once the current task needs durable First Tree platform
  capability — or, for the Context Tree, once a first task has delivered value
  (see Tree Chat Handoff).
- Invitees must not be asked to select team repos, install the team's GitHub
  App, create a duplicate Context Tree, or mutate org-wide setup.
- A GitHub URL alone is not a reason to ask for First Tree GitHub App
  installation. Try host `gh` first.
- Private repo access depends on the member's local host credentials. Do not
  promise access to named private repos until reads actually succeed.
- Authorization, repo creation, pushes, PR creation, and destructive actions
  require explicit user confirmation.

## Hard Rules

- Read before claiming understanding.
- Use concrete evidence, not generic onboarding prose.
- Treat setup as a path to value, not as a first-task option.
- Let the task pull in GitHub App install and repo authorization: raise them
  only when the current task needs it, then guide that step to completion.
- Raise Context Tree build when the task needs it; additionally, once a first
  task has delivered value, an admin (not an invitee) may be prompted to build
  it even when no task forced it — see Tree Chat Handoff. Guide to completion.
- Finish the first task against its own check and show the evidence; never claim
  it works without verifying.
- Give 2-3 bounded first-task options only when evidence supports them.
- Do not put `Skip for now` in request options; rely on the web ask footer Skip.
- Keep the menu as a request when the user is choosing between real tasks.
- Do not block the value chat on Context Tree setup.
- Do not ask for GitHub App installation or repo authorization when host `gh`
  can complete the current GitHub task.
- Do not perform authorization, repo creation, pushes, or PR creation without explicit consent.
- Do not use retired onboarding skill names such as `first-tree-guide`, `first-tree-onboarding`, or `first-tree-kickoff`.
