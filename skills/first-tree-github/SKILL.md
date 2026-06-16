---
name: first-tree-github
version: 0.1.1
cliCompat:
  first-tree: ">=0.5.0 <0.6.0"
description: "Follow / unfollow a GitHub entity (PR, Issue, Discussion, Commit) so its webhook events route into the current chat. Following your own just-created PR or issue is the DEFAULT: use IMMEDIATELY after you create one through any path (`gh pr create`, curl, GitHub MCP, the web UI) — creation never follows for you. Also use when the user asks to watch / track / follow / 关注 / 盯着 a PR or issue; when your current task is blocked on an upstream entity's progress; or to unfollow when the user explicitly asks to stop tracking (unfollow / 取消关注 / stop watching). Do not proactively unfollow merely because a PR or Issue completed, merged, or closed."
---

# First Tree — Follow a GitHub Entity

## What following means

Following wires a GitHub entity's event stream into **this chat**: one
routing line, chat-scoped, not personal. Three properties to internalize
before acting:

- **Every event wakes you.** Each comment, review, CI result on a followed
  entity is delivered as a card addressed to the wiring agent — following
  is active attention with a real cost, not a passive bookmark. Follow
  what the task needs; nothing else.
- **The whole chat sees the stream.** Events land in the shared room,
  including the human's view. You are spending the room's attention,
  not just your own.
- **One line, one room.** A given (human, delegate-agent) line for an
  entity lives in exactly one chat. Following the same entity from a
  second chat conflicts (`409`) — the line can be *moved* (`--rebind`),
  not duplicated.

**Creating is not following.** No creation path — `gh pr create`, curl,
GitHub MCP, the web UI — wires anything for you. If the task depends on
what you just created, declaring that dependency is YOUR job, immediately
after creation.

**Unfollowing is an explicit stop-tracking action:** use it when the
human asks this chat to stop receiving the entity's events. It
disconnects **all** lines wired into this chat for that entity, no
matter how they were created — explicit follow, a mention, or a
`Fixes #N` link. It is not a completion ritual: do not proactively
unfollow merely because a PR or Issue completed, merged, or closed.

## Commands

    first-tree github follow   <entity> [--chat <chatId>] [--rebind]
    first-tree github unfollow <entity> [--chat <chatId>]
    first-tree github following [--chat <chatId>] [--json]

`<entity>` accepts a full GitHub URL (preferred — you usually have it),
`owner/repo#42` (issue vs PR resolved automatically), or `owner/repo@sha`
(commit). Inside an agent session the current chat is inferred; `--chat`
is for terminal / cross-chat use.

(Substitute the channel-correct binary per the top-level first-tree skill.)

## Decision guide

**Follow when — the task acquires a dependency on the entity:**

1. You just created a PR / Issue — through ANY path. **This is the
   default, not a judgment call:** follow it in the same breath as
   creation; the `opened` webhook is already racing you (see the `409`
   row below for when it wins). The only reason to skip is that the
   entity is clearly unrelated to this chat's task ("Do NOT follow"
   rule 3 below).
2. The user asks you to track / watch an entity.
3. Your current task is blocked on an upstream entity and you need its
   progress signals (review submitted, CI finished, merged).

**Do NOT follow when:**

1. The chat already receives the entity's events — run
   `first-tree github following` first when unsure.
2. You'd be bulk-following many entities of a repo. Repo-level watching
   is not supported; do not loop-follow around the limitation.
3. The entity is not something *this chat's task* depends on. Every
   event costs a wake for you and attention for the human — wire the
   stream into the chat whose task actually needs it.

**Unfollow when — the human explicitly asks this chat to stop tracking:**

1. The human asks to stop, unfollow, unsubscribe, cancel watching, or
   otherwise end this chat's GitHub event stream for the entity.

Do **not** proactively unfollow just because the PR or Issue is merged,
closed, completed, or no longer the main active task. Terminal entities
are still followable because review aftermath, reopenings, CI reruns,
post-merge comments, and follow-up decisions can matter to the chat
that did the work.

## Error contract

| Result | Meaning | Your next action |
|---|---|---|
| `201` | now following | report once; do not re-verify |
| `200` already following | idempotent success | treat as success, never retry-loop |
| `409` + chat info | this line already lives in another chat | DEFAULT: work in that chat — the context lives there. One common case: you just created the entity, its `opened` webhook beat your follow and minted a fresh chat — `--rebind` pulls the line into the chat that owns the work. `--rebind` *moves* the entity's attention home: right when the work genuinely lives here, wrong when the other chat still owns it. In doubt, ask the human |
| `404` | entity does not exist on GitHub | re-check the reference; do not retry |
| `422` | repo has no GitHub App installation | following can never deliver events; surface to the human (installation is an operator action) |
| `503` | GitHub temporarily unreachable | retry later; the follow was NOT recorded |
| unfollow `removed: 0` | wasn't following | success, nothing to do |

## Caveats

- **Unfollow is task-scoped, not person-scoped.** After this chat
  unfollows, an explicit @mention of a team member on the entity still
  reaches them — through a freshly minted chat, never back into this
  one. If the human's real intent is "never hear about this entity at
  all", chat-level unfollow cannot deliver that — say so honestly and
  point at GitHub-side unsubscribe or `delegate_mention` configuration
  instead of unfollow-looping.
- **Unfollowing a GitHub-minted chat's own anchor entity is allowed**
  (the room stays, the stream stops). Side effects: the chat topic
  stops tracking the entity's title, and archive bookkeeping for the
  entity detaches from this chat. Proceed only when the human wants
  exactly "keep the room, end the task's attention".
- **Idempotency is part of the contract.** `200 already-following` and
  `removed: 0` are terminal success states. A retry loop on either is a
  bug in your behavior, not in the system.
