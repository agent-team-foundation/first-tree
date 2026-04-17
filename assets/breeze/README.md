# assets/breeze

Runtime assets bundled with the `first-tree` npm package for the `breeze`
product surface.

Currently contains:

- `dashboard.html` — the SSE dashboard served by the breeze daemon HTTP
  server (see `src/products/breeze/daemon/http.ts`).

All breeze logic — CLI commands, daemon, broker, dispatcher, statusline —
is implemented in TypeScript under `src/products/breeze/`. The legacy Rust
runner and bash scripts were removed after the Phase 1–9 port completed.
