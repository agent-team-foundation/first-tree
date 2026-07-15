---
id: runtime-agent-briefing-gitlab-cli
description: Validate generated briefing routing for GitLab CLI creation and native notification subscriptions.
areas: [runtime]
surfaces: [client, cli]
---

# Generated Briefing GitLab CLI

## Goal

Verify that a runtime-generated `AGENTS.md` always gives an agent a compact
GitLab posture and recovery path, routes detailed operations through the
native `glab ... --help` surface, and keeps GitLab account notifications
separate from First Tree chat tracking.

This is a behavior-level QA case for the generated briefing. It does not add a
First Tree GitLab API, event mapper, follow command, or database state.

## Preconditions

- Run in an isolated QA worktree and run cell as required by the QA package.
- Record whether `glab` is available to the selected provider session; presence
  is not evidence of authentication.
- Use a disposable GitLab project or an existing test issue/MR. Do not use a
  production project unless the owner explicitly approves it.
- Keep tokens out of command arguments, shell history, transcripts, and logs.
- If no authenticated GitLab account or disposable project is available, mark
  the live provider branch `BLOCKED`; do not turn missing credentials into a
  product failure.

## Operate

Run the generated briefing through the selected agent provider and first
confirm that both GitLab headings, the compact recovery path, and the
`glab <command> --help` discovery pointers are present whether or not `glab`
is installed. Then ask for a small GitLab task with these subcases:

1. Create an issue or merge request with `glab` first, then subscribe the
   current account to the created entity.
2. Repeat with a deliberately unavailable host, permission, or subscription
   condition so the subscribe command fails after the entity is created.
3. In a separate turn, explicitly ask to stop notifications and verify the
   matching unsubscribe command. Do not use a lifecycle event (close, merge,
   or task completion) as the unsubscribe request.

The agent should inspect native `glab` help before choosing the detailed command
when the exact form is uncertain. When project context is unclear, the command
trace may include repository-disambiguation flags from `glab` help. Common
native forms are:

```text
glab issue subscribe <id-or-url>
glab mr subscribe <iid-or-branch>
glab issue unsubscribe <id-or-url>
glab mr unsubscribe <iid-or-branch>
```

The merge-request forms must not claim URL support. A missing or failed
subscription is a notification gap only; it does not invalidate an entity
that was already created.

## Observe

Capture a redacted transcript and command trace showing:

- the generated briefing contains no session-scoped executable availability
  sentence for `glab` or `gh`;
- `glab` was selected when available, with host/auth checks such as
  `glab auth status` or `glab auth status --hostname <host>` that reveal no
  token;
- the create command completed before the subscribe command;
- the subscribe command used the issue or MR form appropriate to the entity;
- a failure branch preserves the created entity and reports only the missing
  GitLab notification;
- unsubscribe appears only after the explicit human request;
- no `first-tree gitlab follow/unfollow` command, First Tree chat binding, or
  GitHub App installation request is emitted for native GitLab subscriptions.

If `glab` is missing, also verify that the generated briefing still presents
the compact GitLab posture and recovery / discovery pointers, and lets the
agent report the missing CLI without exposing credentials. The full command
catalog must remain outside the generated briefing in this branch.

## Expected Result

`PASS` requires observable command ordering and the separation between GitLab
account notifications and First Tree chat tracking for all available live
subcases. A missing CLI, unavailable host, missing auth, or unavailable
disposable project is `BLOCKED` for the corresponding live branch. Mark the
case `INCONCLUSIVE` when only transcript evidence is available and command
exit/status evidence cannot be recovered.

## Evidence

Keep the generated briefing variant, provider version, redacted transcript,
command argv/exit status, created entity reference, and subscription outcome.
Never attach access tokens, cookies, private keys, or unredacted host-specific
URLs.
