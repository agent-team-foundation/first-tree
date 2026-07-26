# Setup Briefing

Use this briefing to make every formal First Tree product surface testable before planning the requested validation.

## Goal

Create a disposable, complete harness without mutating the operator's checkout, credentials, or shared local services.
For every shipped or publicly promised surface, establish:

- `Build`: final artifact and exact toolchain;
- `Run`: dependencies, configuration, data, startup, and health;
- `Drive`: a real user, operator, consumer, protocol, device, or provider action;
- `Observe`: credible product output or independent state readback;
- `Measure`: lightweight build, size, startup, latency, and resource signals appropriate to the surface;
- `Reset`: a safe way to restore known state and repeat the observation.

## Expected Shape

A formal run has a temporary run root, run-local bare clone and detached worktree, unique Docker project, isolated
networks/volumes/homes, and an external artifact directory. Build and start all formal surfaces, not only those suggested
by the eventual task scope. Use native, device, or provider bridges where Docker cannot credibly host a surface.

## Setup Rules

- Resolve the run root with `realpath` before sharing paths with Docker.
- Mount shared run paths at the same absolute location inside containers.
- Build final deliverables and record ref, artifact hashes or image identities, commands, versions, endpoints, and data.
- Keep server, web, database, CLI runner, daemon, and runtime runner inside Docker where credible.
- Discover dynamic host ports after startup and bind them to loopback by default.
- Continue independent setup probes after one gap when safe so the readiness record is complete.
- Record target failures separately from environment, provider, platform, or harness failures.
- Before readiness, write only `run-context.md` and a provisional checklist; do not select cases or write `plan.md`.

## `QA READY` Gate

Declare `QA READY` only when every formal surface has all six capabilities. Record a lightweight performance baseline
and a reset smoke for each surface. If readiness fails, report the supported status and evidence without entering formal
task execution.

Run artifacts are temporary process output. Summarize them to the requester; never commit them to the repository.
