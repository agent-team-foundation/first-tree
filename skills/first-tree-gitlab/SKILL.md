---
name: first-tree-gitlab
description: Operate GitLab through the host `glab` CLI. Use for GitLab URLs, merge requests, issues, pipelines or jobs, repository metadata, comments, ordinary issue/MR creation, native notification subscribe/unsubscribe requests, or GitLab host/auth/access recovery. Keeps GitLab account notifications separate from First Tree chat tracking and uses the documented issue/MR identifier forms.
---

# First Tree GitLab

Use the host `glab` CLI for GitLab operations. This skill owns the detailed
commands that stay out of the always-present agent briefing.

## Preflight

1. Confirm `glab` is executable in the current provider environment. Treat the
   generated briefing's availability sentence as a startup probe, not proof of
   authentication or project access.
2. Let `glab` infer GitLab.com, GitLab Dedicated, or GitLab Self-Managed from
   the current repository remote when possible. When the host is ambiguous,
   inspect the remote and pass the intended hostname explicitly.
3. Check authentication with `glab auth status` or
   `glab auth status --hostname <host>`. Inspect command-specific syntax with
   `glab <command> --help` before guessing flags.
4. If `glab` is missing, unauthenticated, points at the wrong host, or lacks
   access, report the exact gap and take the narrowest recovery: install GitLab
   CLI, run `glab auth login --hostname <host>`, fix project permissions, or use
   a local clone.

Never print a token or place one in command arguments, logs, transcripts, or
shell history. Use the CLI's supported credential flow.

## Create And Subscribe

For an ordinary issue or merge request, inspect `glab issue create --help` or
`glab mr create --help`, create the entity, and verify creation succeeded before
subscribing. Subscribe the current authenticated account by default when the
entity was created for this task. Skip subscription when the entity is
unrelated or the user explicitly does not want notifications.

Use these native forms:

```text
glab issue subscribe <id-or-url>
glab mr subscribe <iid-or-branch>
```

When repository context is unclear, add `-R <group/project>`. The merge-request
form accepts an IID or branch; do not claim URL support. Confirm installed CLI
syntax with `glab issue subscribe --help` or `glab mr subscribe --help`.

A subscribe failure is only a GitLab notification gap. It does not invalidate
an issue or merge request that was already created; report creation and
subscription outcomes separately.

## Unsubscribe

Unsubscribe only when a human explicitly asks to stop notifications. Do not
unsubscribe because an issue closes, an MR merges, or the task finishes.

Use these native forms:

```text
glab issue unsubscribe <id-or-url>
glab mr unsubscribe <iid-or-branch>
```

When repository context is unclear, add `-R <group/project>`. The same MR
IID-or-branch constraint applies. Inspect `glab issue unsubscribe --help` or
`glab mr unsubscribe --help` when the installed CLI's flags are uncertain.

## First Tree Boundary

GitLab native subscriptions affect only notifications for the current
authenticated GitLab account. They do not bind GitLab events to a First Tree
chat, install or require the First Tree GitHub App, or create First Tree server
state. Do not invent or run `first-tree gitlab follow` or
`first-tree gitlab unfollow` commands.
