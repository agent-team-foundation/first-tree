# Docker Run Cell

A Docker run cell is the disposable execution boundary for formal QA.

## Principles

- Run only the services required by the selected QA scope.
- Keep product services inside Docker when they are part of the tested behavior.
- Use a unique Compose project name per run.
- Keep state in run-local volumes or run-root subdirectories.
- Bind web/server ports to loopback by default and discover actual ports after startup.
- Do not expose Postgres, artifact directories, provider homes, runtime homes, or host credential stores.

## Typical Roles

- `postgres` for isolated database state.
- `cli` for in-container command execution.
- `server` for API behavior.
- `web` for browser-visible behavior.
- daemon/runtime runner only when runtime behavior is in scope.

This package does not provide a lifecycle CLI. The agent chooses the concrete Compose file and commands for the task.
