# Write Workflow

Five steps. The user has already given you a specific source. Your job is
to produce zero, one, or a small set of tree changes that reflect it.

## Step 1: Read The Source

Read the source end-to-end before drafting anything. Sources include:

- one or more code PRs (link, diff, description, review thread)
- a design doc, RFC, or spec
- meeting notes
- raw text the user pasted

If the source is a GitHub PR, also read the linked issue and any review
comments. Decisions often live in the comments, not the diff.

## Step 2: Identify Tree-Worthy Content

Apply the filter in [references/what-belongs.md](what-belongs.md). For
each candidate fact in the source:

- Does it establish or change a decision, constraint, ownership, or
  cross-domain relationship?
- Is it durable across the next refactor?

If both are yes, it belongs. Build a short list of tree-worthy items.

If the list is empty, stop. Tell the user "nothing in this source belongs
in the tree" and explain why. Do not invent content.

## Step 3: Choose The Smallest Correct Update

For each tree-worthy item, find the right node:

| Situation                                  | Where it goes                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------- |
| The decision belongs to an existing domain | Update that domain's `NODE.md` or add a leaf in that domain                           |
| The decision spans two domains             | Add a leaf in the more-specific domain; add a `soft_links` entry from the broader one |
| The decision is genuinely new              | Add a new domain directory with its own `NODE.md`                                     |
| Ownership or workspace map change          | Update `members/` or `source-repos.md`, not a domain leaf                             |

Bias hard toward editing existing nodes. Adding new domains is a high-bar
move — only when no existing domain fits.

## Step 4: Draft With Rationale, Not Code Detail

For each change, write:

- the durable claim (what is true now)
- the rationale (why)
- a link back to the source PR / doc / note that motivated it

Do not paste diffs into the tree. Do not list class names or function
signatures. The tree's job is to compress.

Frontmatter rules:

- Every node needs `title:` and `owners:`. New nodes inherit ownership
  from the parent unless the user told you otherwise.
- New cross-domain references go in `soft_links:`.
- Avoid editing `lastReviewed:` or `decisionLocksCode:` flags unless the
  user explicitly asked for it.

## Step 5: Verify And Link

Before opening the PR:

```bash
first-tree tree verify --tree-path <tree-root>
```

Must exit 0. If it fails, fix the structure issue before submitting.

Open the PR against the tree repo with:

- a title summarizing the durable claim (not "update tree")
- a body that links the source PR / doc and explains why each touched
  node was chosen
- the assignee set to the affected node's `owners` (first owner if the
  list is multiple)

Branch naming: `write/<source-id>/<short-slug>` (e.g.
`write/pr-1234/auth-middleware-rule`).

## Hand-Off Cases

If during the write task you notice **other** drift the user did not ask
about:

- finish the write task as scoped
- in the PR body, add a "Suggested follow-up" section listing the drift
- do **not** chain into `first-tree-sync` automatically — let the user
  decide

If during reading you realize the source is actually drift discovery
(no specific update intended, just "look at this area"):

- stop the write task
- suggest `first-tree-sync` instead

See [boundary.md](boundary.md) for the full sync-vs-write decision table.

## What This Workflow Does NOT Do

- It does not merge the PR. Reviewer policy is the tree repo's business.
- It does not touch the source repo. Write only edits the tree.
- It does not retry on review feedback. Owners may rewrite the PR; write
  produces a starting point, not a final answer.
