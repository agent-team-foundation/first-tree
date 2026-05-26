# When To Involve A Human

Set `github-scan:human` and route `human` when **any** of these triggers
fires. Do not route `human` for any other reason.

## The Four Triggers

### 1. New decision required

The notification asks for or implies a choice that is not already covered
by an existing tree node, RFC, or merged decision.

Examples:

- "Should we drop support for X?" — answering no — would mean making the
  decision.
- "Two reviewers disagree on the right framing." — picking one is a new
  decision.
- A code change introduces a behavior the tree does not address.

The agent does **not** make new decisions. Even if the agent has an
opinion, the right move is to surface the question and let a human
decide.

### 2. Owner unclear

The relevant tree node has no `owners`, has stale `owners`, or the
ownership question is itself the issue.

Examples:

- The affected domain's `NODE.md` has `owners: []`.
- The listed owner has not touched the area in 6+ months.
- The notification is a cross-team request and the boundary of
  responsibility is in dispute.

If the agent has to pick an owner from thin air to proceed, it is
already at trigger 1. Stop and route `human`.

### 3. Cross-domain impact

The notification has consequences in a domain other than the one it was
filed under, and resolving it requires a coordinated decision.

Examples:

- A PR in `auth` changes a contract that `gateway` and `sdk` depend on,
  and the SDK owners have not been looped in.
- An issue mentions both `billing` and `compliance`; the right fix
  affects both.

A change confined to a single domain is **not** cross-domain just
because it touches multiple files. Cross-domain means cross-`NODE.md`.

### 4. Rules cannot pick

Tree rules and the github-scan tag/comment templates exhaust the
options, and none fits.

Examples:

- The notification is in a language the agent cannot reliably parse.
- The expected action is something the agent is forbidden from doing
  (deleting comments, force-pushing, mass-tagging users).
- The repo lacks the `github-scan:*` labels and you cannot create them.

## Anti-Triggers

These are NOT reasons to involve a human:

- "I have not read the tree yet." — read the tree first.
- "The PR is large." — size is not a trigger.
- "The user might prefer a sync sweep." — that is a `sync` route, not
  `human`.
- "I want a sanity check." — do not route `human` for reassurance.
- "The disclosure sentence makes the comment awkward." — post the
  disclosure separately (see `references/comments.md`).

## How To Hand Off

When you decide to route `human`:

1. Set `github-scan:human` (remove the previous `github-scan:*` label
   in the same operation — see `references/tags.md`).
2. Post one comment using the `route=human` template in
   `references/comments.md`.
3. End the run with:
   ```
   GITHUB_SCAN_RESULT: status=handled route=human summary=<one-line>
   ```
4. Stop. The daemon's auto-revert mechanism pulls the item back to
   `github-scan:new` when the human replies.

Do not @ unrelated maintainers. Do not @ the entire team. Tag the
specific owner the tree lists, or — if owner is the unclear part — tag
nobody and rely on the tree owners to triage.
