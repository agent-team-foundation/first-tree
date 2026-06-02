# Fix Workflow

Sync's second phase: take the `drifts[]` from the audit phase and decide,
per finding, whether to:

- **auto-fix** — open a tree-repo PR with the correction (structural
  edits only; never decision prose)
- **write-handoff** — surface the source pointer and invoke
  `first-tree-write`
- **needs-human** — leave a label or comment for human disambiguation
- **skip** — the finding is a false positive or out of scope

## Default Routing By Drift Type

| Drift type                    | Default route                                                                                             | Notes                                                                                                               |
| ----------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `tree-stale`                  | auto-fix                                                                                                  | Code is the ground truth; mechanical update.                                                                        |
| `tree-wrong`                  | auto-fix when the correction is small; needs-human if rationale changes                                   | Always link the offending PR / commit so reviewers see the source of truth.                                         |
| `tree-outdated`               | needs-human                                                                                               | Superseding decisions cross domains; require an owner.                                                              |
| `code-not-synced/structural`  | auto-fix                                                                                                  | Skeleton-only changes: NODE.md domain entries, source-repos.md additions, org.yaml dep registration, member stubs.  |
| `code-not-synced/substantive` | write-handoff (always)                                                                                    | Sync surfaces the source pointer and stops. Substantive write goes through write's "default to not writing" filter. |
| `cross-domain-broken`         | auto-fix when the new target is unambiguous; needs-human when the link could go to multiple replacements. |
| `ownership-stale`             | needs-human always                                                                                        | Ownership changes are high-trust and require a person.                                                              |

`decisionLocksCode: true` on the tree node overrides the default to
`needs-human` regardless of type — never auto-fix a locked node.

## Auto-Fix Workflow

For each drift routed to auto-fix:

1. Branch off the tree repo's default branch:
   `chore(sync)/<drift-type>/<short-slug>`.
2. Make the smallest correct change to the tree node. Keep diffs minimal.
   For `code-not-synced/structural`:
   - **new domain**: add a one-line entry to the parent `NODE.md` domain
     list and create `<domain>/NODE.md` with `title`, `owners: []`
     frontmatter and an empty body. Do **not** describe what the domain
     does — that's substantive.
   - **new submodule**: add the path to `source-repos.md`. Do not bind
     it as its own tree (that's a user decision via
     `first-tree tree init`).
   - **new dep**: append to `.first-tree/org.yaml` `techStackConstraints`.
   - **new member**: create `members/<slug>/NODE.md` with `title`,
     `owners: []`, `type: human`, `role: contributor` frontmatter and
     empty body.
3. Update the node's frontmatter `lastReviewed:` (if the field exists) or
   leave frontmatter alone.
4. Commit with a message in the form:
   `sync(tree): <drift-type> — <one-line summary>`.
5. Open a PR against the tree repo with:
   - the `evidence` from the drift entry as the body
   - a link to the source PR / commit / file that motivated the correction
   - the assignee set to the node's `owners` (first owner if multi)

Do not bundle multiple drifts into one PR unless they touch the same
node and are the same type. Multiple `code-not-synced/structural`
findings against unrelated paths still get one PR each.

## Needs-Human Workflow

For each drift routed to needs-human:

1. Open a PR or issue on the tree repo with the drift evidence.
2. Apply a label that describes the request type (e.g. `tree-drift`,
   `ownership-review`, `superseded-decision`). Prefer existing repository
   labels before inventing new ones.
3. Tag the listed `owners` of the affected node.
4. Stop. Do not edit the tree until the human responds.

## Skip Conditions

Mark a finding as skip when:

- the audit produced a false positive (rerun classification — usually
  `tree-wrong` candidates fall here)
- the disagreement is intentional and documented elsewhere
- the user has explicitly told you to ignore this area

Always log the skip reason. Skipped findings should still appear in the
`drifts[]` output with `route: "skip"` so downstream tooling can audit the
audit.

## Hand-Off To `first-tree-write`

Every `code-not-synced/substantive` finding hands off to write — this is
the default route, not an opt-in. Mechanics:

1. Group the substantive findings in the audit output under a "write
   candidates" header. Each entry shows `sourcePointer` and `summary`.
2. Print one invocation suggestion per finding:
   ```
   /first-tree-write source=<sourcePointer>
   ```
3. Stop. Do not auto-invoke write — that would bypass write's "default
   to not writing" filter and the user's review of which gaps are
   actually tree-worthy.

For `tree-stale` / `tree-wrong` cases where the user gave you a specific
source PR to reflect, you can also hand off — same shape.

Sync's job ends when each drift is classified and routed. Write turns
one specific source into one tree update. See `references/boundary.md`.

## What This Workflow Does NOT Do

- It does not merge the auto-fix PRs. Reviewer policy is the tree repo's
  business.
- It does not retry on review feedback. Owners may rewrite the PR; sync
  gives them a starting point, not a final answer.
- It does not loop. One audit → one fix pass → done. Run sync again if you
  want another sweep.
