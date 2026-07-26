# Durable Seed progress

Read this reference before writing the Phase 1 progress record or deciding
whether a populated Context Tree may resume Phase 2. The record replaces
setup-chat history and private local caches as the continuation authority.

## Required invocation identity

A portable Seed invocation has exactly three explicit inputs:

- one `selectedTeamId`;
- one task-local Context Tree path; and
- one or more ordered source inputs.

Run `first-tree tree seed --team <selectedTeamId> --json` first. A bound
response supplies the only authoritative Tree repo and branch. The task-local
checkout must have a credential-free `origin` canonically equal to that repo.
Strictly fetch only the bound branch and resolve its exact commit. Do not read
progress from a mutable local branch, a stale checkout, another Team, or a
managed Workspace fallback.

## Exact file contract

Phase 1 adds `.first-tree/progress.md` to its structure PR/MR. Preserve any
unrelated existing content, but add exactly one Seed section in this shape:

````markdown
<!-- first-tree-seed-progress:v1 -->

# First Tree Seed Progress

- [x] Seed Phase 1 structure

## Seed identity

<!-- first-tree-seed-ledger:v1 -->

```json
{
  "schemaVersion": 1,
  "teamId": "019example-team-id",
  "sources": [
    {
      "identity": "github.com/acme/api",
      "commit": "0123456789abcdef0123456789abcdef01234567"
    }
  ],
  "approvedTopLevels": ["product", "system"]
}
```
````

The JSON block is canonical:

- use exactly the four top-level keys shown above and no duplicate keys;
- keep `schemaVersion` equal to `1` and `teamId` equal to the explicit Team;
- sort `sources` by `identity`, require unique identities, and store the exact
  lowercase 40- or 64-hex commit actually read in Phase 1;
- sort unique `approvedTopLevels` lexicographically and store directory names
  without slashes; and
- never store credentials, access tokens, source checkout paths for remote
  repositories, PR/MR identifiers, chat identifiers, or transcript text.

Use these canonical source identities:

- recognized remote: lowercase host plus the complete repository path, with
  transport, user, port, query, fragment, trailing slash, and `.git` removed;
  preserve the path's spelling and every nested GitLab namespace segment;
- local repository with a non-local `origin`: canonicalize that remote by the
  same rule; or
- repository with no remote or only a local-path remote:
  `local:<absolute-realpath-of-repo-root>`.

Different transports for the same remote, such as HTTPS and scp-like SSH, must
produce the same identity. Embedded credentials make an input invalid rather
than becoming part of the identity.

Do not write an unchecked Phase 2 item. `first-tree tree verify` treats every
unchecked item in `.first-tree/progress.md` as a failure. Phase 2 marks
completion by adding this second checked line while leaving the ledger intact:

```markdown
- [x] Seed Phase 2 content
```

The progress file is operational supporting state under `.first-tree/`, not a
normal decision node. Normal nodes must not link to it or rely on it for their
meaning.

## Phase 1 write boundary

Before creating the Phase 1 branch:

1. Resolve every explicit or managed source according to the main skill.
2. Fetch each source and resolve the exact commit used for evidence.
3. Materialize source worktrees at those exact commits before content reads.
4. Build the canonical ledger and include it with the approved structure.
5. Run `first-tree tree verify` on the complete Phase 1 branch.

Immediately before the Phase 1 push and again before PR/MR creation, repeat the
Seed preflight. Require current Admin authority plus the same canonical Tree
repo and exact branch. Query the forge for the deterministic
`chore/seed-phase1-structure` branch and an open PR/MR from that head before
creating either. Reuse an existing branch only after fetching it and confirming
that it descends from the exact bound-branch base, contains the same Team/source
ledger, and has only the expected Phase 1 scope. Otherwise stop and report the
conflict; never reset, overwrite, or force-push it. A retry reuses verified
observable remote state instead of duplicating it.

## Phase 2 recovery algorithm

An explicit request to resume Seed is the trigger; the skill does not poll.
Perform these checks in order from a new process or agent:

1. Run a fresh Seed preflight for `selectedTeamId`. Require current active
   Admin and a bound state.
2. Verify the task-local Tree checkout's canonical `origin` equals the returned
   repo. Strictly fetch the returned branch and resolve one exact Tree commit.
3. Inspect `.first-tree/progress.md` from a detached checkout of that exact
   commit. Require exactly one progress marker and one ledger marker, valid
   canonical JSON, the exact Team id, the checked Phase 1 line, and no checked
   Phase 2 line.
4. Confirm every ledger `approvedTopLevels` directory exists at that exact Tree
   commit.
5. Re-resolve all explicit source inputs without reading source content.
   Canonicalize and sort their identities, then require an entry-for-entry match
   with the ledger. Extra, missing, duplicated, or changed identities fail.
6. Fetch each matched source. Require its recorded exact commit to remain
   readable with `git cat-file -e <commit>^{commit}`, then materialize the Phase
   2 read worktree at that recorded commit. Do not silently substitute the
   source's newer default-branch head.
7. Create or reuse `chore/seed-phase2-content` from the exact fetched Tree
   commit. Reuse is allowed only when the fetched remote branch descends from
   that exact commit, preserves the ledger byte-for-byte, and contains only
   Phase 2 scope; otherwise stop without resetting, overwriting, or
   force-pushing it. Add initial leaves and the checked Phase 2 line, preserve
   the ledger, run `first-tree tree verify`, and inspect the complete diff.
8. Repeat Seed preflight immediately before push and immediately before PR/MR
   creation. Require the same Team, canonical binding repo, and branch. Query
   the forge by deterministic head branch first and reuse existing state.

The prior chat, its title, a current-message claim, private cache files, and a
familiar domain layout are never inputs to this algorithm.

## Fail-closed outcomes

- No marker on a populated tree: refuse unrelated re-seeding and route future
  source-backed work to `first-tree-write`.
- Checked Phase 2 line: report Seed complete and do not reopen either phase.
- Malformed/duplicate marker or ledger, Team mismatch, source identity
  mismatch, unreadable exact commit, missing approved domain, binding change,
  or lost Admin role: stop and name the mismatched stage without starting a new
  Seed.
- Failure before push or PR/MR creation: report that no such remote mutation
  was attempted by this run.
- Failure after a repository, branch, binding, or PR/MR may exist: inspect and
  report the real entity and current binding. Never claim rollback. On retry,
  reuse the deterministic branch and existing PR/MR by head.
