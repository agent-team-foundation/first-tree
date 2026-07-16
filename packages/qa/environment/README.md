# Environment Recipes

Formal First Tree QA uses a complete, disposable Docker-backed harness so validation does not mutate the operator's
checkout or shared services.

## Temporary Source Worktree

Use a run-local bare clone as the owner of the tested worktree:

```bash
RUN_ROOT=/tmp/first-tree-qa-runs/<run-id>
mkdir -p "$RUN_ROOT/artifacts"
RUN_ROOT_REAL=$(realpath "$RUN_ROOT")
git clone --bare --no-hardlinks <source-repo> "$RUN_ROOT_REAL/repo.git"
git --git-dir="$RUN_ROOT_REAL/repo.git" worktree add --detach "$RUN_ROOT_REAL/source" <target-ref>
```

`realpath` matters on macOS because `/tmp` normally resolves through `/private/tmp` and git stores absolute worktree
paths. Mount the resolved root at the same absolute path inside containers.

This recipe materializes committed refs only. If requested behavior depends on unreproducible local state, report the
limitation or `BLOCKED`; never silently test a different target.

## Complete Docker Run Cell

- Use a unique Compose/project prefix and run-local networks, volumes, homes, ports, and data.
- Build and start the complete First Tree product surface: final CLI/package artifacts, production Server/Web image and
  Postgres, documentation, portable artifacts, runtime/daemon paths, and other shipped surfaces discovered at the ref.
- Bind public endpoints to loopback and discover dynamic host ports after startup.
- Do not expose Postgres, artifacts, provider homes, runtime homes, or host credential stores.
- Use native or platform bridges for artifacts that cannot execute credibly in Linux Docker; keep their state run-local.
- Define reset and cleanup for every surface before declaring readiness.

The task scope is chosen after the cell reaches `QA READY`; it does not decide which formal surfaces are initialized.

## Provider Bridge

Classify provider readiness as `binary-detected`, `binary-launchable`, or `one-turn-ready`. A provider-backed product
operation requires `one-turn-ready`; a binary probe alone cannot prove real agent behavior.

Discover host state first, bridge only the minimum required material, prefer read-only copies/mounts, and use a compatible
runtime binary for the target platform. Never mount a full host provider home writable. Missing auth, entitlement,
compatible binaries, or authorized turn capacity is `BLOCKED`, not product `FAIL`.
