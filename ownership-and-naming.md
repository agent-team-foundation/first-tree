---
title: "Node Naming and Ownership Model"
status: approved
---

# Node Naming and Ownership Model

## Summary

This proposal defines how nodes are structured, named, and owned in a Context Tree repository.

## NODE.md as the Parent Node

Every folder in the tree **must** contain a `NODE.md` file. This file serves two purposes:

1. **Description** — it is the human- and agent-readable explanation of the domain that folder represents.
2. **Ownership** — its frontmatter declares who owns all content within the folder.

Example:

```yaml
# backend/NODE.md
---
title: Backend Architecture
owners: [alice, bob]
soft_links: [/infrastructure/deployments]
---

This subtree covers the backend service architecture, including API design,
data access patterns, and service-to-service communication.
```

## Ownership Rules

1. **NODE.md is the folder-level authority.** Its owners can approve changes to any file within the folder.

2. **Leaf files can declare their own owners.** These owners can approve changes to that specific file. This is additive — `NODE.md` owners retain full authority over all files in the folder.

3. **Multiple owners are allowed.** On both `NODE.md` and leaf files.

4. **Inheritance with override.** If a `NODE.md` does not declare owners, it inherits from the nearest parent directory's `NODE.md` that does. When a `NODE.md` explicitly declares owners, it fully overrides the parent — the parent folder's owners have no implicit authority over child folders.

5. **Every folder requires a NODE.md.** Creating a subfolder means someone must think about ownership — either declare owners explicitly or inherit from the parent.

## Example

```
/backend/
  NODE.md          ← owners: [alice]
  auth.md          ← owners: [carol]
  storage.md       ← (no owners declared)
```

- **auth.md** — both Alice and Carol can approve changes
- **storage.md** — only Alice can approve changes (governed by NODE.md)
- **NODE.md** — only Alice can approve changes

## Leaf Files

Any `.md` file in a folder other than `NODE.md` is a leaf node. Leaf nodes:

- Contain content with optional frontmatter (title, owners, soft_links, etc.)
- Are always governed by the folder's `NODE.md` ownership in addition to any owners they declare

## CODEOWNERS Generation

The CLI can generate a GitHub `CODEOWNERS` file from all `NODE.md` and leaf file frontmatter in the tree. This gives teams PR-level enforcement of the ownership model without custom tooling.

Example generated output:

```
# Auto-generated from Context Tree. Do not edit manually.
/backend/          @alice
/backend/auth.md   @alice @carol
/frontend/         @dana @eli
```

## Why This Design

- **Simple to resolve ownership** — `NODE.md` owners always apply; leaf file owners are additive.
- **Tree structure enforces clarity** — ownership disagreements at the folder level are resolved by splitting into subtrees.
- **Folder creation is deliberate** — requiring `NODE.md` with owners prevents folder sprawl.
- **Flexible without complexity** — leaf files can have specialized owners without introducing override semantics.
- **Git-native** — everything is a file, versioned, reviewable in PRs.
