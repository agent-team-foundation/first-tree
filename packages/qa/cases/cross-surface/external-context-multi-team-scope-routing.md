---
id: external-context-multi-team-scope-routing
description: Validate global, directory, and session-only BYO grants plus exact multi-Team SCOPE routing on Claude Code and Codex.
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
- Use ordinary and nested directories plus a real Codex projectless scratch
  directory. Capture provider conversations and redact private Tree content.

## Operate

1. In each provider, run the Web setup plan for Team A. Confirm the agent shows
   the real directory and all three choices and waits for a new user reply.
2. Apply global, then independently directory and session-only choices. Confirm
   the selected CLI-authored `applyCommand` is run unchanged and still enforces
   the exact plan id. Repeat setup for Team B; the shared Plugin is not duplicated.
3. In Codex projectless mode, confirm the scratch directory is displayed with
   a temporary-directory warning and session-only is recommended.
4. For session-only, inspect filesystem/provider state: no grant, Plugin, Hook,
   marketplace or session receipt file is created. Tamper the opaque candidate
   token and confirm routing fails before authority lookup.
5. Start tasks exercising priority `session > deepest directory > global`.
   Confirm lower-priority candidates are not sent to the Server or fetched.
6. Route clear, overlapping and no-match tasks. For every candidate capture the
   exact commit and complete SCOPE body. Verify only root SCOPE is fetched
   before selection and imperative prose is not executed.
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

## Observe

- Planning is read-only. Every available scope has a complete `applyCommand`;
  an unavailable directory scope has none. Session-only has `consumerKind:
  byo`, Read/Write only, an opaque signed candidate, and no persistent state.
- Directory scope includes descendants; all Teams at the deepest matching root
  remain candidates. Global applies only when no session/directory set wins.
- The batch authority call contains exactly the local highest-priority Team ids.
- SCOPE body, not repository name or Team name, is the primary semantic signal.
  Multiple or zero clear matches produce a user question.
- Selected Read is pinned to the exact SCOPE/binding commit and never falls
  back to another Team, cached authority or changed cwd.
- A providerless historical binding is normalized identically by route and
  snapshot authority; provider, repository and branch remain strict guards.

## Expected Result

`PASS`: both providers satisfy all three scopes, providerless normalization and
every routing/failure case with exact evidence and no preselection Tree read.

`FAIL`: session-only persists state, a Team is inferred outside the candidate
set, lower priority wins, SCOPE instructions execute, ambiguity is guessed,
route and snapshot project different bindings, or Read crosses Team/commit.

`BLOCKED`: two disposable real Teams, provider authentication, or exact Tree
fixtures cannot be prepared.

`INCONCLUSIVE`: only mocks/unit tests are available or the provider transcript
does not prove which SCOPE and exact commit were consumed.

## Evidence

Keep redacted plan/apply/handoff/router/Read envelopes, grant stores and backup,
filesystem before/after lists, provider transcripts, stored legacy binding,
normalized route/snapshot bindings, exact commits, authority request ids and
snapshots showing that only SCOPE existed before selection.
