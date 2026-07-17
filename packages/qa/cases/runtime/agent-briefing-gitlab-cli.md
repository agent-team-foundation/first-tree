---
id: runtime-agent-briefing-gitlab-cli
description: Validate generated briefing routing between glab provider actions, First Tree GitLab chat attention, and native account notifications.
areas: [runtime]
surfaces: [client, cli, server, gitlab]
---

# Generated Briefing GitLab CLI

## Goal

Verify that the runtime-generated `AGENTS.md` keeps GitLab provider actions on
the native `glab` surface while making First Tree chat attention the one default
post-create action for in-scope Issues and Merge Requests. Native GitLab account
subscriptions remain opt-in and semantically independent.

## Preconditions

- Run in an isolated QA worktree and run cell as required by the QA package.
- Use a disposable Team with one GitLab connection, an existing First Tree chat,
  and a disposable GitLab project whose webhook can reach the test deployment.
- Record whether `glab` is available and authenticated; presence alone is not
  evidence of authentication.
- Keep tokens and the First Tree webhook bearer out of command arguments,
  shell history, transcripts, and logs.
- If no authenticated GitLab account or disposable project is available, mark
  the live provider branch `BLOCKED`; deterministic briefing/CLI checks may
  still proceed.

## Operate

Render the generated briefing through the selected provider and confirm both
GitLab headings and the `glab <command> --help` discovery pointer are present.
Then ask the agent to perform these subcases:

1. Create an in-scope GitLab Issue or Merge Request with `glab`, then run
   `first-tree gitlab follow <full-url>` for the current chat.
2. Create another entity and force First Tree follow to fail after creation
   (for example, use a Team without a GitLab connection or a wrong-origin URL).
3. Ask for personal GitLab account notifications and verify that the agent uses
   the native `glab` subscribe form only after this explicit request.
4. In a separate turn, explicitly ask the chat to stop tracking the entity and
   verify `first-tree gitlab unfollow <current-url>`. Do not use close, merge,
   or task completion as the unfollow request.

Inspect native `glab` help before choosing an uncertain create or subscription
form. Do not require a native subscription after ordinary creation.

## Observe

Capture a redacted generated briefing and command trace showing:

- the create command completed before `first-tree gitlab follow`;
- the follow used a full Issue or Merge Request URL and targeted the current
  chat implicitly or through `--chat`;
- the initial result is explicitly pending until a matching valid inbound
  webhook, with no claim that First Tree verified the entity through GitLab;
- follow failure preserves the already-created entity and reports only the
  First Tree chat-attention gap;
- no native `glab subscribe` action occurs unless the human explicitly asks for
  personal-account notifications;
- `gitlab unfollow` appears only after the explicit human request, removes
  automatic and manual bindings in the current chat, treats `removed: 0` as
  terminal success, and explains that a later directed personnel event may
  create a new route;
- the `gitlab` namespace exposes only `follow`, `following`, and `unfollow`,
  with no `--rebind`, `--connection`, `--mapping-id`, or `context-review`;
- no GitHub App installation request is emitted for GitLab chat attention.

## Expected Result

`PASS` requires observable separation between provider actions, First Tree chat
attention, and personal GitLab notifications; post-create chat follow is the
only default attention action. A missing CLI, unavailable host, missing auth,
or unavailable disposable project is `BLOCKED` only for the corresponding live
branch. Mark `INCONCLUSIVE` when command exit/status evidence cannot be
recovered.

## Evidence

Keep the briefing variant, provider version, redacted transcript, command
argv/exit status, created entity reference, follow/list/unfollow results, and
native subscription outcome when explicitly exercised. Never attach access
tokens, cookies, private keys, webhook bearers, or unredacted private-host URLs.
