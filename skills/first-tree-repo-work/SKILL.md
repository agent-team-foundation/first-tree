---
name: first-tree-repo-work
version: 1.0.0
description: Use when a First Tree repo-work kickoff explicitly asks for first-tree-repo-work, especially growth/onboarding chats that start from a GitHub repo URL and should find continuable engineering tasks.
---

# First Tree Repo Work

## Scope

Use this skill only when a First Tree system kickoff explicitly asks for
`first-tree-repo-work`, or when the chat is clearly a repo work thread created
from the growth path. Do not use it for ordinary PR reviews, Context Tree setup,
generic onboarding welcome chats, or non-repo support.

## Goal

Turn a one-off coding-agent session into a First Tree repo work thread: use the
user's local computer to inspect the repo, find work worth continuing, ask the
user to choose one task, then maintain a pinned Task Brief so the work can be
resumed, handed off, or extended into a PR/team workflow.

## Operating Principles

1. **Local-first access.** Prefer the connected computer's local clone, `gh`,
   git credentials, or browser-authenticated clone path. Do not require GitHub
   App installation before reading the repo.
2. **Evidence before claims.** Inspect files, commands, tests, issues, or
   dependency metadata before saying what the repo needs.
3. **Continuable tasks over generic findings.** A good task has a clear goal,
   bounded scope, verification path, likely files, and a next step that can
   become a PR, follow-up thread, or teammate handoff.
4. **Keep setup in service of work.** If `gh` is missing, help install or fall
   back to git/local clone only as far as needed to inspect the repo.
5. **Preserve thread state.** After the user chooses a task, update the chat
   description with a Task Brief. Keep it current when scope or status changes.

## First Response Workflow

Before the first substantive reply:

1. Read the kickoff message for the repo URL and agent name.
2. Locate the repo locally or make it accessible:
   - if a local path is already present, inspect it;
   - if `gh` is available, use it to verify auth and clone/fetch the repo;
   - if `gh` is missing, give the smallest install/fallback step for this OS;
   - if private repo access fails, ask for a local clone path or credential step.
3. Inspect enough evidence to form task candidates:
   - README/package manifests/build config;
   - recent tests or failing commands if cheap;
   - obvious risk surfaces such as CI, auth, data migrations, flaky tests,
     dependency drift, or incomplete feature seams.
4. Present 2-3 continuable task candidates.

Do not start broad implementation before the user chooses a candidate unless
they explicitly asked for a specific task.

## Candidate Format

Each candidate should include:

- **Task** — concrete work, not a vague category.
- **Why it matters** — user-facing, reliability, security, quality, or velocity
  impact.
- **Evidence** — files, commands, logs, or code paths inspected.
- **Scope** — likely boundaries and non-goals.
- **First verification** — the first test, command, or manual check.
- **Continuation value** — why this is good for First Tree to keep as a thread:
  PR potential, review follow-up, teammate handoff, or durable repo knowledge.

Avoid generic lists like "improve tests", "refactor code", or "fix bugs" unless
they are anchored in inspected evidence and a bounded first step.

## Task Brief

After the user chooses a candidate, update the chat description with:

```markdown
Working on <repo> repo task: <short task title>.

**Task Brief**
- Goal: <one sentence>
- Scope: <files/areas in scope and one notable non-goal>
- Key files: <file paths or directories>
- Plan: <2-4 ordered steps>
- Status: <current state>
- Next step: <single next action>
```

Use the First Tree chat update command available in the runtime briefing. Keep
the description concise and update it when the plan, status, or next step
changes.

## GitHub App Handoff

Do not bring GitHub App installation into the initial repo-reading path. Bring
it up only when the chosen task needs durable GitHub-side capabilities such as:

- opening or updating a PR from First Tree;
- commenting on a PR or issue;
- following GitHub events in the thread;
- long-term team repo/resource integration.

When that point arrives, explain the specific capability needed. Do not ask for
abstract integration "just in case".
