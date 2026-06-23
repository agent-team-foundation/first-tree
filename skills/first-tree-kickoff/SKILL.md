---
name: first-tree-kickoff
version: 1.0.0
description: Use only for First Tree onboarding kickoff system messages. Guides the agent's first value-first chat: read the user's repo or team context, show concrete understanding, ask the user to choose a bounded first task, and keep Context Tree setup in a separate/background lane.
---

# First Tree Kickoff

Use this skill only when a First Tree system kickoff message explicitly asks you to use `first-tree-kickoff`, or when the chat is clearly the onboarding first chat created by First Tree. Do not use it for ordinary chats, PR reviews, tree writes, or maintenance work.

## Goal

Give the user a fast, concrete "this agent understands my code and can help" moment, then guide them into one useful first task. Context Tree setup is important, but it is not the user's first job in this chat.

## First Response Contract

Before replying, read the available repo, local path, GitHub URL, or team Context Tree named by the kickoff. If there is no repo yet, ask the user for a local clone path or GitHub URL and explain that you can read it on their machine before any GitHub authorization.

Your first substantive reply must do all of this:

1. State specific understanding from evidence: stack, entry points, important modules, tests, TODOs, conventions, risks, or repo shape you actually observed.
2. Ask the user to choose a first task using a `format=request` message.
3. Offer 2-3 task options, plus `Skip for now`.
4. Accept free text as another valid answer.
5. Mention Context Tree at most once, with a plain gloss such as "your team's shared memory", and only as a side note.

Do not pretend the user sent the kickoff. First Tree sent it.

## Choosing Fast-Value Tasks

Pick tasks that help the user feel value quickly. A good kickoff task is:

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
- Vague options such as "improve code quality".
- Claims of bugs without evidence.
- Work that needs new credentials, production access, or irreversible actions before the user explicitly agrees.

If the repo evidence is thin, choose read-only orientation tasks instead of inventing implementation work.

## Request Shape

After the evidence paragraph, send a tracked request to the human. Use concise option labels and one-sentence descriptions. Include a `Skip for now` option. Make clear they can also type anything else.

Example shape:

```text
I found a Next.js app with checkout code in `app/checkout/` and no nearby tests. I also noticed `middleware/auth.ts` has a TODO for expired sessions.

What should we do first?
- Add checkout tests: Cover the happy path and one failure case.
- Fix expired-session handling: Turn the TODO into concrete behavior and tests.
- Map the app architecture: Give you a short guide to routes, data, and auth.
- Skip for now: Keep chatting without starting a task.
```

## No Repo Yet

If First Tree says no repo is connected:

1. Do not ask for GitHub App authorization first.
2. Ask for either a local clone path or a GitHub URL.
3. If they provide a local path, inspect it on the machine and give the same evidence-backed task request.
4. If they provide a GitHub URL, use local git/gh credentials when available; if access fails, explain the exact next step.
5. Only after giving value should you ask whether this should become long-term team code.

Long-term team setup, GitHub App authorization, or `gh repo create` all require explicit user confirmation. Use a tracked ask for those confirmations.

## Context Tree Lane

If a separate Context Tree setup chat exists or is about to be created, keep this value chat focused on helping the user start work. You may say one short sentence such as:

"I’ll also let the separate setup chat build your team’s Context Tree, the shared memory future agents use."

Do not run a heavy tree seed in this chat unless First Tree explicitly put you in the tree setup chat. In a tree setup chat, use `first-tree-seed`, `first-tree-read`, or `first-tree-write` as appropriate.

## Hard Rules

- Read before claiming understanding.
- Use concrete evidence, not generic onboarding prose.
- Give 2-3 bounded first-task options with `Skip for now`.
- Keep the menu as a request so the user is guided toward one real task.
- Do not block the value chat on Context Tree setup.
- Do not perform authorization, repo creation, pushes, or PR creation without explicit consent.
- Do not use the retired `first-tree-onboarding` skill name.
