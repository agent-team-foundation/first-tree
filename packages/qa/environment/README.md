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

## Mock GitHub App

The GitHub App surface (install-url, installation-token minting, repository catalog, signed webhook ingest) needs a
configured App. A real App/webhook secret is often unavailable in an isolated cell, so a run may report those sub-areas
`BLOCKED`, or mock them to validate First Tree's own request/parse/verify logic. Reusable assets live in
`fixtures/github-app/` (mock REST API + webhook payloads + full recipe).

- The App config block is all-or-nothing: set every `FIRST_TREE_GITHUB_APP_*` field together (id, client id/secret,
  private key, webhook secret; plus `_SLUG` for install-url) or the server rejects it at boot. A clean boot omits the
  "GitHub App not configured" log line and the webhook route stops returning its 501 stub.
- Generate a throwaway PKCS#8 key at run time (`openssl genpkey -algorithm RSA`); never commit one. Pass the multi-line
  PEM via a shell export, or a quoted `--env-file` value (Node 22.13+ supports quoted multi-line env values) — the export
  just avoids the quoting/escaping fuss.
- Redirect REST calls with `FIRST_TREE_GITHUB_API_BASE_URL` set to a URL the server can reach (`localhost` only if the
  mock shares the server's container; otherwise the compose service name or `host.docker.internal`). The mock answers two
  endpoints only (token + repos), so paths needing other GitHub REST — a real `follow`'s `/repos/:o/:r` +
  `/repos/:o/:r/issues/:n`, OAuth, org repos — fall through and stay out of scope.
- Sign webhooks with `x-hub-signature-256: sha256=<HMAC-SHA256(webhook_secret, raw_body)>` and set `x-github-event` /
  `x-github-delivery`. This exercises signature verification, record-only install recording, and delivery-id dedup.

A mock proves the deployment's request/parse/verify wiring, not github.com's live responses; the real install dialog and
full followed-chat card delivery stay out of an isolated cell.
