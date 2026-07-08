# Temporary Git Worktree

Formal QA should use a temporary source worktree, not the operator's original checkout.

## Recommended Recipe

```bash
RUN_ROOT=/tmp/first-tree-qa-runs/<run-id>
RUN_ROOT_REAL=$(realpath "$RUN_ROOT")
git clone --bare --no-hardlinks <source-repo> "$RUN_ROOT_REAL/repo.git"
git --git-dir="$RUN_ROOT_REAL/repo.git" worktree add --detach "$RUN_ROOT_REAL/source" <target-ref>
```

Use the temporary bare clone as the worktree owner so containerized git commands can resolve the git directory without
depending on the original checkout.

Mount the run root at the same absolute path in containers when host and container artifact paths need to match.
