---
name: first-tree-welcome
version: 1.0.0
description: Use when a First Tree onboarding, welcome, intro, or kickoff system message asks the agent to orient a new user, use first-tree-welcome, guide initial GitHub/repo/Context Tree setup, or start the value-first first chat.
---

# First Tree Welcome

Use this skill only when a First Tree system onboarding message explicitly asks
you to use `first-tree-welcome`, or when the chat is clearly the onboarding
welcome / intro / first work chat created by First Tree. Do not use it for
ordinary chats, PR reviews, tree writes, or maintenance work.

## Goal

Help the user feel First Tree's core value: an agent can work from their GitHub
code repo and their team's Context Tree. Guide any missing setup just enough to
unlock that value, then steer the welcome chat toward one small, useful,
verifiable task. Heavy Context Tree setup runs in a separate chat.

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
- kickoff kind: `intro`, `work`, or `tree`;
- GitHub App: missing, installed, or unknown;
- code repo: selected/recommended, local path/URL provided, or none;
- Context Tree: no binding, newly bound empty tree, bound populated tree, or unknown;
- tree setup chat: already exists, explicitly promised by kickoff, or absent.

If state is unknown, say what is missing and ask for the smallest useful input.
Do not invent repo access, GitHub authorization, or tree readiness.

## Setup State Matrix

| State | What to do |
| --- | --- |
| Repo and team context are readable | Read them, cite concrete evidence, then offer first-task options. |
| GitHub App installed but no repo selected | Explain that repo selection lets the agent work with code long-term; guide the user to select a repo in the product surface. If any local path/URL is available, inspect it now for immediate value. |
| GitHub App missing | Explain the practical value of installing it: repo access, webhook/entity context, and team setup. Do not require it before giving value from a local path or accessible URL. |
| No repo connected | Ask for one local clone path or GitHub URL. Local code can be read before long-term team setup. |
| Repo readable but Context Tree missing/empty | Give code-based value in this chat. Mention that the separate tree chat will build the team's shared memory; do not make tree setup a first-task option. |
| Bound populated Context Tree | Read it with the repo context and use it to make better task suggestions. Do not seed it. |
| Invitee on a ready team | Read inherited team repos/tree where the member's local credentials allow it, then orient and offer a small task. |
| Invitee on a not-ready team | Do not show admin setup, select repos, or create a duplicate tree. Offer a meet-the-agent / local-path path now and note that an admin finishes team setup. |
| Tree kickoff chat | This is the heavy tree lane. Use `first-tree-seed`, `first-tree-read`, or `first-tree-write` as appropriate instead of this value-chat flow. |

Cloud onboarding owns one-click Context Tree repo bootstrap and org binding.
Agents may seed an empty bound tree or update a populated bound tree in the
correct tree chat, but must not silently create, bind, or duplicate team-wide
setup from the welcome chat.

## First Response Contract

Your first substantive reply in a welcome / intro / work chat must:

1. State specific understanding from evidence: stack, entry points, important
   modules, tests, TODOs, conventions, risks, repo shape, or team context you
   actually observed.
2. Name at most one missing setup step if it blocks durable value, and explain
   why it matters in product terms.
3. If enough evidence exists, ask the user to choose a first task using a
   `format=request` message.
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
- Do not put `Skip for now` in request options; rely on the web ask footer Skip.
- Keep the menu as a request when the user is choosing between real tasks.
- Do not block the value chat on Context Tree setup.
- Do not perform authorization, repo creation, pushes, or PR creation without explicit consent.
- Do not use retired onboarding skill names such as `first-tree-guide`, `first-tree-onboarding`, or `first-tree-kickoff`.
