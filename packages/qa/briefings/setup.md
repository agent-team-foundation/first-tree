# Setup Briefing

Use this briefing to prepare an isolated QA run cell. The agent owns the exact commands for the current task and host.

## Goal

Create a disposable environment where product behavior can be observed without mutating the operator's original checkout
or shared local services.

## Expected Shape

A formal run normally has:

- a temporary run root;
- a one-time bare clone inside that run root;
- a detached source worktree materialized from the target ref;
- a unique Docker Compose project name;
- run-local Docker networks and volumes;
- run-local homes for First Tree, provider state, browser state, and service state;
- an `artifacts/` directory for plans, reports, logs, evidence, and bug artifacts.

The exact services scale with the QA scope. A CLI-only task may need only a runner container and source worktree. API
validation usually needs Postgres plus server. Web validation usually needs web, server, database, and browser tooling.
Runtime validation needs a provider bridge only when real agent behavior is in scope.

## Setup Rules

- Resolve the run root with `realpath` before mounting it into Docker.
- Mount the run root at the same absolute path inside containers when artifact paths must be shared between host and
  container.
- Run only the services needed by the selected QA scope.
- Keep server, web, database, CLI runner, daemon, and runtime runner inside Docker when they are part of the tested
  scope.
- Discover dynamic host ports after services start and record them in the run context.
- Treat setup failures as `BLOCKED` when they prevent the requested validation.

## Run Context

Record enough setup state for someone else to interpret the report:

- target ref and source path;
- run root and artifact path;
- Compose project name and active services;
- service URLs or dynamic ports;
- data setup steps;
- provider/auth readiness state;
- setup limitations or degraded paths.

## Artifact Boundary

Run artifacts are temporary process output. They should be summarized back to the requester, not committed to the source
repository.
