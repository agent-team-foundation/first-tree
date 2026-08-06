---
id: external-context-multi-team-scope-routing
description: Validate dynamic BYO setup choices plus exact multi-Team SCOPE routing on Claude Code and Codex.
areas: [cross-surface]
surfaces: [web, server, cli, claude-code, codex, context-tree]
---

# External Context Multi-Team SCOPE Routing

## Goal

Prove that one provider session can authorize several Teams without silently
choosing the wrong Tree. Verify that only the highest-priority local candidates
are checked, complete exact `SCOPE.md` bodies drive semantic selection, and no
full Tree is read before one candidate is fixed.

## Preconditions

- Use isolated provider homes and the shipped staging portable CLI.
- Prepare at least two real Teams with different bound Trees and valid root
  `SCOPE.md` files. One SCOPE must describe a non-programming domain.
- Prepare clear-match, overlapping, no-match, missing-SCOPE, imperative-text,
  membership-revoked, and branch-moving variants.
- Use ordinary and nested directories, a pathless session, a real Codex
  projectless scratch directory, and a default Codex managed worktree under
  `$CODEX_HOME/worktrees/<id>/<repo>`. Capture provider conversations and
  redact private Tree content.

## Operate

1. In each provider from a stable ordinary directory, run the Web setup plan
   for Team A. Confirm the agent shows the real directory, returns global,
   directory, and session choices, and waits for a new user reply.
2. Apply global, then independently directory and session-only choices. Confirm
   the selected CLI-authored `applyCommand` is run unchanged and still enforces
   the exact plan id. Repeat setup for Team B; the shared Plugin is not duplicated,
   its adapter identity is unchanged, Claude does not reload, and Codex does not
   request trust again.
3. Repeat setup in a pathless session, a Codex projectless scratch directory,
   and a default Codex managed worktree. Confirm each plan returns only global
   and session choices: directory is absent and no directory apply command is
   available. The scratch and managed-worktree plans display their canonical
   path identity with a temporary-directory warning, and session-only is
   recommended.
4. For session-only, inspect filesystem/provider state: no grant, Plugin, Hook,
   marketplace or session receipt file is created. Tamper the opaque candidate
   token and confirm routing fails before authority lookup.
5. Start tasks exercising priority `session > deepest directory > global`.
   Confirm lower-priority candidates are not sent to the Server or fetched.
6. Route unique clear-match, all-clearly-unrelated, overlapping, and unclear
   tasks. For every candidate capture the exact commit and complete SCOPE body.
   Verify only root SCOPE is fetched before selection and imperative prose is
   not executed. A unique clear match selects automatically. When every
   readable candidate is clearly unrelated, verify the agent continues the
   original task without a snapshot or user question. Overlap or unclear
   relevance produces a user question without automatic selection.
7. Exercise one readable clear-match candidate beside one missing/invalid
   SCOPE, then beside one authority-unavailable candidate. Verify
   `selectionBlocked: true`, an unconditional user question, no automatic
   selection of the readable candidate, and that the unavailable candidate
   itself cannot be selected.
8. Store a valid legacy binding for the selected Team without `provider`, using
   each supported HTTPS, SSH URL, and scp-like transport in turn. Confirm route
   and the member-safe snapshot authority return the same resolved `provider`,
   repository and branch, then materialize and read the route-pinned commit.
9. Change the provider, repository or branch, move the binding branch, and
   revoke membership between route and Read. Confirm every changed authority
   is rejected before Git fetch or full Tree content and the task routes again.
10. Change cwd after handoff and after selection. Confirm the immutable provider
   project and selected receipt remain authoritative.
11. Seed a new Tree from an explicit Team and confirm Phase 1 proposes a
    natural-language SCOPE with no fixed section template.
12. Place a v2 context store in a disposable home. Confirm it is atomically
    backed up, v3 starts empty, and the user must authorize again.
13. Select the same Team once from Claude and once from Codex. Confirm both
    snapshots are created from one `data/byo/<org>/context-tree.git`, while an
    equivalent binding in another Team uses a physically separate bare repo.
14. Switch the local Client from account A to B and back to A. Confirm each
    account sees only its parked/restored BYO repositories, an A receipt fails
    under B, reset removes active and parked BYO data, and an active Write
    blocks the switch before any move journal is created.

## Observe

- Planning is read-only. Stable directories return all three choices, while
  pathless, Codex scratch, and default managed-worktree locations omit the
  directory choice entirely. Every returned scope has a complete
  `applyCommand`. Session-only has `consumerKind: byo`, Read/Write only, an
  opaque signed candidate, and no persistent state.
- Directory scope includes descendants; all Teams at the deepest matching root
  remain candidates. Global applies only when no session/directory set wins.
- The batch authority call contains exactly the local highest-priority Team ids.
- SCOPE body, not repository name or Team name, is the primary semantic signal.
  One clear match selects automatically. All readable candidates being clearly
  unrelated produces no snapshot and no user question. Multiple possible
  matches, unclear or overlapping SCOPE bodies, any unavailable candidate, or
  `selectionBlocked` produces a user question.
- Selected Read is pinned to the exact SCOPE/binding commit and never falls
  back to another Team, cached authority or changed cwd.
- Unselected route candidates leave no long-lived clone. The selected Team's
  bare repo is shared across providers and branches, while task snapshots stay
  temporary, detached, and remote-free.
- A providerless historical binding is normalized identically by route and
  snapshot authority; provider, repository and branch remain strict guards.

## Expected Result

`PASS`: both providers return the choices appropriate to each location,
providerless normalization and every routing/failure case have exact evidence,
and no Tree is read before selection or after a clear all-unrelated result.

`FAIL`: an unstable/pathless plan exposes directory activation, session-only
persists state, a Team is inferred outside the candidate set, lower priority
wins, SCOPE instructions execute, an all-clearly-unrelated result asks the user
or creates a snapshot, ambiguity is guessed, route and snapshot project
different bindings, or Read crosses Team/commit.

`BLOCKED`: two disposable real Teams, provider authentication, or exact Tree
fixtures cannot be prepared.

`INCONCLUSIVE`: only mocks/unit tests are available or the provider transcript
does not prove which SCOPE and exact commit were consumed.

## Evidence

Keep redacted plan/apply/handoff/router/Read envelopes, grant stores and backup,
filesystem before/after lists, provider transcripts, stored legacy binding,
normalized route/snapshot bindings, exact commits, authority request ids and
snapshots showing that only SCOPE existed before selection.
