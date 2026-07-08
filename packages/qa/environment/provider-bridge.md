# Provider Bridge

Provider state can be an input to runtime QA, but it must be bridged into the isolated run cell deliberately.

## Readiness Levels

- `binary-detected`: a provider binary or bundled source is detected.
- `binary-launchable`: the provider binary can start, or provider doctor/smoke checks pass.
- `one-turn-ready`: provider auth and runtime session state are sufficient for a real agent turn.

Real agent behavior cases require `one-turn-ready`.

## Boundary

- Discover host provider state first.
- Copy or read-only mount only the minimum credential material needed for the run.
- Use a Linux-compatible provider binary inside Docker.
- Do not assume a macOS or Windows host binary can run inside the container.
- Do not mount the full host provider home as writable shared state.

Missing provider/auth readiness is `BLOCKED`, not product `FAIL`.
