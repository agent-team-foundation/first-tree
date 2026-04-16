# assets/breeze

Runtime assets bundled with the `first-tree` npm package for the `breeze`
product surface.

## Bash scripts removed in phase 2b

All CLI-side commands are now TypeScript. The previous bash scripts under
`assets/breeze/bin/` (`breeze-poll`, `breeze-watch`, `breeze-status`,
`breeze-status-manager`, `breeze-statusline-wrapper`) were removed when
their TS ports landed in `src/products/breeze/commands/` and
`src/products/breeze/statusline.ts`.

The Rust daemon (`first-tree-breeze/breeze-runner/`) is still the sole
implementation for the daemon commands (`run`, `run-once`, `start`,
`stop`, `status`, `cleanup`, `doctor`); the CLI dispatcher bridges those
to the binary. The daemon port is Phase 3.

The bundled `setup` script under `first-tree-breeze/setup` is also still
bash; it is reached via `first-tree breeze install`. Phase 3 replaces it.
