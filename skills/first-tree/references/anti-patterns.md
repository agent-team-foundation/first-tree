# Anti-Patterns

Avoid these failure modes when updating First Tree:

- using the tree as a wiki dump for every implementation detail
- copying source code structure into the tree when the relationship is not decision-relevant
- writing speculative future plans without marking them as proposals elsewhere
- storing transient task state that belongs in issues or PRs
- treating the tree as a substitute for reading the relevant source repo

If the information helps someone execute but not decide, it probably belongs in
the source repo instead.
