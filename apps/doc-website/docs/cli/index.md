# CLI

Install the CLI with the shell installer for your release channel, then sign
the computer in with a connect code from the First Tree web console.

## Production

```bash
curl -fsSL https://download.first-tree.ai/releases/prod/install.sh | sh
~/.local/bin/first-tree login <connect-code>
```

## Staging

```bash
curl -fsSL https://download.first-tree.ai/releases/staging/install.sh | sh
~/.local/bin/first-tree-staging login <connect-code>
```

The macOS/Linux installers bundle Node.js. The explicit `~/.local/bin` paths
work immediately, even before the current shell reloads `PATH`. For a
self-hosted deployment, use the exact two-line command shown by its web
console so the installer and login command receive the correct server and
download-base overrides.

Development builds use `scripts/dev-install.sh` from a source checkout and
sign in with `first-tree-dev login <connect-code>`.
