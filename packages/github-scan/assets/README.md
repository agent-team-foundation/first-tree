# `@first-tree/github-scan` assets

Runtime assets bundled with the package for the github-scan product surface.

Currently contains:

- `dashboard.html` — the SSE dashboard served by the github-scan daemon HTTP
  server (see `src/github-scan/engine/daemon/http.ts`).

All github-scan logic — CLI commands, daemon, broker, dispatcher, statusline —
is implemented in TypeScript under `src/`.
