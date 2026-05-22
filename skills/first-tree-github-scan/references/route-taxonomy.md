# Route Taxonomy

Every notification handled by this skill ends with exactly one route. The
daemon parses `GITHUB_SCAN_RESULT:` for the route value, so the choice
must be deterministic.

## The Four Routes

| Route   | When to pick it                                                                                                                       | Agent stays here                                                    | Hand-off                   |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------- |
| `reply` | The notification can be handled entirely on GitHub with labels, review comments, or a single reply. No tree change is required.       | yes                                                                 | none                       |
| `human` | A human must step in: ownership unclear, decision missing, cross-domain impact unresolved, or rules cannot pick between alternatives. | no — set `github-scan:human` and stop                               | wait for human auto-revert |
| `sync`  | The notification means the tree may be stale, wrong, outdated, or otherwise needs a broader audit of the relevant area.               | no — load `first-tree-sync` SKILL.md and continue under that skill  | `first-tree-sync`          |
| `write` | The notification provides explicit source material (PR, doc, note) that should be reflected in the tree.                              | no — load `first-tree-write` SKILL.md and continue under that skill | `first-tree-write`         |

## Choosing The Route

Run through the test in this order; pick the first match.

1. **Is a human's input or judgment required to proceed?** → `human`
2. **Does the notification carry a specific source the user wants
   reflected in the tree (PR link, doc, note)?** → `write`
3. **Does the notification suggest the tree may be stale, wrong, or
   missing coverage in a broader area, but no specific update is
   requested?** → `sync`
4. **Otherwise, the GitHub side is enough.** → `reply`

If multiple match, the earlier one wins. Do not split a single
notification into two routes — pick the more specific one and leave a
follow-up suggestion for the other.

## Examples

| Notification                                                            | Route                                         |
| ----------------------------------------------------------------------- | --------------------------------------------- |
| Reviewer asks "can you rerun CI?"                                       | `reply`                                       |
| PR comment "this contradicts our auth rule — see ADR-12"                | `human` (an ownership/rule disagreement)      |
| Issue: "Tree node X is wrong — function `foo` was removed last quarter" | `sync`                                        |
| PR description: "this changes the public API; please update the tree"   | `write`                                       |
| Mention with no actionable ask                                          | `reply` (acknowledge briefly, set `done`)     |
| CI failure where the cause is environmental                             | `reply` (link to logs, set `done`)            |
| CI failure where a tree-stated invariant is now broken                  | `sync`                                        |
| New repo joins the workspace, tree's `source-repos.md` is silent        | `write` (the repo registration is the source) |

## GITHUB_SCAN_RESULT Format

The final line of the agent's output must be:

```
GITHUB_SCAN_RESULT: status=<handled|skipped|failed> route=<reply|human|sync|write> summary=<one-line summary>
```

| Field     | Values                               | Meaning                                                                    |
| --------- | ------------------------------------ | -------------------------------------------------------------------------- |
| `status`  | `handled`                            | The agent finished the work (including handing off)                        |
| `status`  | `skipped`                            | The agent decided no action was needed (including missing-label fallbacks) |
| `status`  | `failed`                             | The agent crashed or could not produce a usable outcome                    |
| `route`   | `reply` / `human` / `sync` / `write` | As above                                                                   |
| `summary` | one line                             | Short, human-readable. No newlines.                                        |

Examples:

```
GITHUB_SCAN_RESULT: status=handled route=reply summary=acked the mention; nothing to do
GITHUB_SCAN_RESULT: status=handled route=human summary=ownership unclear; flagged @alice
GITHUB_SCAN_RESULT: status=handled route=sync summary=loaded first-tree-sync; auditing auth domain
GITHUB_SCAN_RESULT: status=skipped route=human summary=cannot set labels — repo permission denied
```

## What Routes Are NOT

- `reply` is **not** a "default route". If the right answer is `human`
  or `sync` or `write`, do not collapse it to `reply` because reply is
  cheaper. The router will look at every result; under-routing erodes
  trust.
- `human` is **not** "I am stuck." It is "a human must judge." If you
  are stuck because you have not read the tree, read the tree. Use
  `human` only when the missing piece is a person, not an effort.
- `sync` and `write` are **not** "this might have tree implications."
  They are "the tree definitely needs work and here is what kind." If
  you are unsure, route `human`.
