# Environment Recipes

Formal QA runs use a disposable run cell so validation does not mutate the operator's checkout or shared local services.

## Temporary Source Worktree

Use a run-local bare clone as the owner of the tested worktree:

```bash
RUN_ROOT=/tmp/first-tree-qa-runs/<run-id>
mkdir -p "$RUN_ROOT/artifacts"
RUN_ROOT_REAL=$(realpath "$RUN_ROOT")
git clone --bare --no-hardlinks <source-repo> "$RUN_ROOT_REAL/repo.git"
git --git-dir="$RUN_ROOT_REAL/repo.git" worktree add --detach "$RUN_ROOT_REAL/source" <target-ref>
```

Mount the run root at the same absolute path inside containers when host and container artifact paths need to match.

## Docker Run Cell

Use Docker for product services that are part of the tested behavior.

Principles:

- run only the services required by the selected QA scope;
- keep state in run-local volumes or run-root subdirectories;
- use a unique Compose project name per run;
- bind web/server ports to loopback by default and discover actual ports after startup;
- do not expose Postgres, artifact directories, provider homes, runtime homes, or host credential stores.

Common service shapes:

- CLI or docs behavior: source worktree plus a command runner.
- API behavior: Postgres plus server.
- Web behavior: Postgres, server, web, and browser tooling.
- Runtime behavior: runtime runner plus provider bridge, only when real agent behavior is in scope.

## Provider Bridge

Provider state can be an input to runtime QA, but it must be bridged deliberately.

Readiness levels:

- `binary-detected`: a provider binary or bundled source is detected.
- `binary-launchable`: the provider binary can start, or provider doctor/smoke checks pass.
- `one-turn-ready`: provider auth and runtime session state are sufficient for a real agent turn.

Real agent behavior cases require `one-turn-ready`.

Boundary:

- discover host provider state first;
- copy or read-only mount only the minimum credential material needed for the run;
- use a Linux-compatible provider binary inside Docker;
- do not assume a macOS or Windows host binary can run inside the container;
- do not mount the full host provider home as writable shared state.

Missing provider/auth readiness is `BLOCKED`, not product `FAIL`.
