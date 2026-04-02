# Context Tree Maintenance Principles

## Table Of Contents

- Product boundary
- Command model
- Decision model
- Organization model
- Ownership model
- Member model
- Validation invariants
- Upgrade and workflow model
- Common failure modes

## Product Boundary

All paths below are relative to the `first-tree` repo root.

- `first-tree` is the template source and CLI for Context Tree. It is not a tree repo itself.
- `.context-tree/` is the shipped framework payload. `context-tree init` copies it into a user repo and renders top-level scaffolding from templates.
- `src/` is the CLI implementation that decides how users see onboarding, tasks, verification, and upgrade prompts.

Read these first when the boundary is unclear:

- `AGENTS.md`
- `README.md`
- `src/cli.ts`
- `src/init.ts`

## Command Model

- `context-tree init`:
  - requires a git repo
  - clones `https://github.com/agent-team-foundation/seed-tree`
  - copies `.context-tree/`
  - renders `NODE.md`, `AGENT.md`, and `members/NODE.md` from templates when missing
  - adds `context-tree-upstream`
  - prints onboarding text
  - writes `.context-tree/progress.md`
- `context-tree verify`:
  - fails when unchecked items remain in `.context-tree/progress.md`
  - checks framework presence
  - checks root `NODE.md` frontmatter
  - checks `AGENT.md` framework markers
  - runs node validation
  - runs member validation
- `context-tree upgrade`:
  - requires an existing `.context-tree/`
  - fetches upstream `.context-tree/VERSION` from `context-tree-upstream/main`
  - writes an upgrade-specific `.context-tree/progress.md`
  - tells the user to resolve framework conflicts, then re-run `context-tree verify`
- `context-tree help onboarding` prints `docs/onboarding.md` through `src/onboarding.ts`.

Authoritative sources:

- `src/cli.ts`
- `src/init.ts`
- `src/verify.ts`
- `src/upgrade.ts`
- `src/onboarding.ts`

## Decision Model

The tree stores information an agent needs to decide on an approach, not the execution detail required to carry it out.

Keep these ideas intact:

- The tree is the living source of truth, not a historical snapshot.
- If source systems contradict the tree, treat that as a tree bug and fix the tree before proceeding.
- Agents should read the tree before deciding and ask after every task whether the tree now needs updating.
- Cross-domain relationships, rationale, and non-obvious constraints belong in the tree.
- Function signatures, route inventories, database schemas, and other execution-level details stay in source systems unless they are themselves decision-critical.

Authoritative sources:

- `.context-tree/principles.md`
- `docs/about.md`
- `docs/onboarding.md`
- `.context-tree/templates/agent.md.template`

## Organization Model

- Organize domains by concern, not by code repo, team boundary, or org chart.
- Start flat. Create subdomains when a domain can no longer be scanned quickly.
- Root `NODE.md` is the domain map. It must list every top-level domain that actually exists.
- `NODE.md` files explain the domain, its boundaries, and which deeper nodes matter.
- Leaf files capture specific decisions or designs under the domain.
- `soft_links` connect related domains without turning the tree into a full graph.

Authoritative sources:

- `.context-tree/principles.md`
- `docs/onboarding.md`
- `.context-tree/templates/root-node.md.template`
- `src/validators/nodes.ts`

## Ownership Model

- Every folder in a tree must contain `NODE.md`.
- Every node must declare an `owners` field in frontmatter.
- `owners: []` inherits from the nearest parent `NODE.md`.
- `owners: [*]` means anyone can approve that node or folder, but wildcard cannot be mixed with usernames.
- Folder `NODE.md` ownership is the folder-level authority.
- Leaf owners are additive; they do not remove authority from the folder `NODE.md` owners.
- When a child folder declares its own owners, it overrides the parent folder for that child subtree.

Authoritative sources:

- `.context-tree/ownership-and-naming.md`
- `src/validators/nodes.ts`
- `.context-tree/generate-codeowners.ts`

## Member Model

- `members/` is mandatory for a real tree and must have `members/NODE.md`.
- Every member is a directory that contains `NODE.md`, not a standalone markdown file.
- Required frontmatter fields for member nodes:
  - `title`
  - `owners`
  - `type`
  - `role`
  - `domains`
- Valid `type` values are exactly:
  - `human`
  - `personal_assistant`
  - `autonomous_agent`
- `domains` must contain at least one entry.
- Nested members are allowed.
- Member directory names must be unique across the full `members/` subtree.
- `delegate_mention`, when present, must point to an existing member directory whose type is `personal_assistant`.

Authoritative sources:

- `.context-tree/templates/members-domain.md.template`
- `.context-tree/templates/member-node.md.template`
- `src/validators/members.ts`

## Validation Invariants

These are the non-obvious checks that shape correct tree maintenance:

- Missing frontmatter is an error.
- Missing `owners` is an error.
- Invalid GitHub usernames in `owners` are an error.
- `soft_links` must resolve to a real node or directory-with-`NODE.md`.
- Every non-hidden directory in the tree must contain `NODE.md`.
- A top-level domain directory that exists but is not listed in root `NODE.md` is an error.
- A domain listed in root `NODE.md` but missing on disk is an error.
- A leaf file that exists but is not mentioned in its folder `NODE.md` is a warning, not an error.
- A soft link without a reverse reference is an info-level finding, not an error.
- Very short node bodies are warnings.
- Frontmatter title mismatches against the first heading are warnings.
- `context-tree verify` also treats unchecked progress items as failures, even before node/member validation runs.

Authoritative sources:

- `src/verify.ts`
- `src/validators/nodes.ts`
- `src/validators/members.ts`

## Upgrade And Workflow Model

- The upgrade path is framework-centric: compare local `.context-tree/VERSION` with upstream and guide the user through reconciling framework files.
- `AGENT.md` has framework markers and a user-editable section after them. Upgrades should preserve the custom section while checking whether the framework block changed.
- `.context-tree/workflows/validate.yml` is the baseline CI validation workflow.
- `.context-tree/workflows/pr-review.yml` is optional and is set up only if the user opts into AI PR review.
- `.context-tree/workflows/codeowners.yml` auto-generates `.github/CODEOWNERS` from tree ownership on PRs.
- `.context-tree/generate-codeowners.ts` resolves inherited owners, additive leaf owners, and wildcard exclusions.
- `.context-tree/scripts/inject-tree-context.sh` and `.context-tree/examples/claude-code/` show how agent integrations preload root context.

Authoritative sources:

- `src/upgrade.ts`
- `src/rules/ci-validation.ts`
- `.context-tree/workflows/validate.yml`
- `.context-tree/workflows/pr-review.yml`
- `.context-tree/workflows/codeowners.yml`
- `.context-tree/generate-codeowners.ts`
- `.context-tree/scripts/inject-tree-context.sh`
- `.context-tree/examples/claude-code/README.md`

## Common Failure Modes

- Treating `first-tree` as if it were itself a tree repo and forgetting that `.context-tree/` is shipped content.
- Putting organization-specific content into `.context-tree/`.
- Changing validator behavior without updating task text, docs, templates, or tests that teach the same rule.
- Adding execution details to the tree model instead of keeping the tree focused on decisions and relationships.
- Forgetting that `progress.md` is part of verification semantics, not just a human note file.
- Changing ownership behavior without checking `generate-codeowners.ts`.
