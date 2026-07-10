---
id: portable-shell-onboarding
description: Validate that hosted prod and staging onboarding install the public portable artifact, invoke the channel-correct binary only after installer success, and recover an existing stale installation safely.
areas: [cross-surface]
surfaces: [server, web, cli]
---

# Portable Shell Onboarding

## Goal

Confirm the fresh-computer and recovery paths across server, web, the public download service, and CLI: a prod or staging
server mints the canonical guarded shell bootstrap, the web copies it without reconstructing it, the public installer
selects the matching channel artifact, and only a successfully installed binary may run `login`. A failed fetch or
installer run must never fall through to an older executable already present at the channel's `~/.local/bin` path.

Run both hosted channels. The expected commands, with the minted connect code substituted for `<connect-code>`, are:

```sh
# Staging
installer_tmp=$(mktemp "${TMPDIR:-/tmp}/first-tree-install.XXXXXX") && (trap 'rm -f "$installer_tmp"' 0; curl -fsSL https://download.first-tree.ai/releases/staging/install.sh -o "$installer_tmp" && sh "$installer_tmp" &&
~/.local/bin/first-tree-staging login <connect-code>)

# Production
installer_tmp=$(mktemp "${TMPDIR:-/tmp}/first-tree-install.XXXXXX") && (trap 'rm -f "$installer_tmp"' 0; curl -fsSL https://download.first-tree.ai/releases/prod/install.sh -o "$installer_tmp" && sh "$installer_tmp" &&
~/.local/bin/first-tree login <connect-code>)
```

Deterministic product tests own string construction and escaping. This case owns the live boundaries those tests cannot
prove: the web/API handoff, the public installer chain, the installed channel identity, a real first login, and recovery
from a stale executable. The separate `curl -o` step must preserve a fetch failure without relying on non-POSIX
`pipefail`; the shared `&&` chain must gate login on download, verification, and installation success.

## Preconditions

- Run the target ref in an isolated Docker + temporary git-worktree run cell. Do not install either channel on the
  operator host or reuse its First Tree homes, credentials, daemon, or shell profile.
- Build the shipped server/web artifact from the target ref. Run separate prod and staging server stacks, or reset all
  database and client state before switching channel configuration.
- Give each channel a fresh-install runner with a clean writable `HOME` and a separate recovery runner whose writable
  `HOME` contains a known older, still login-compatible channel installation at `~/.local/bin/first-tree` or
  `~/.local/bin/first-tree-staging`. Both runners should have `sh`, `curl`, CA certificates, and the installer's normal
  archive/checksum tools, but no system Node.js requirement; the portable artifact must supply its own runtime.
- On Linux, give the runner's test user a real systemd user manager and D-Bus user session. Verify that
  `systemctl --user status` can reach the manager before testing. A plain container without a working user bus cannot
  validate this case: `login` must install and start the background daemon, so a missing manager or bus is `BLOCKED`.
  Do not add `--no-start`, mock the supervisor, or accept a credentials-only login as a substitute.
- Public network access to `https://download.first-tree.ai` is required. Record the resolved public metadata/version for
  each mutable `install.sh` entry point so the report distinguishes the tested public release from the source target ref.
- Provide an isolated HTTP fault server and a run-local mirror of the selected channel's installer, metadata, checksum,
  and portable artifact. The fault server must be reachable only inside the QA run cell and support deterministic outer
  installer-fetch failure, downstream installer failure, and successful unmodified mirror modes. Do not change public
  download objects or route fault traffic through the operator host.
- Use throwaway server secrets, databases, users, and connect codes. A non-production QA auth bootstrap may be enabled
  inside the run cell, but never bridge a real hosted account or credentials into it.

Configure each isolated server with the channel's canonical public URL when capturing the hosted command
(`https://cloud.first-tree.ai` for prod and `https://dev.cloud.first-tree.ai` for staging). The CLI still needs to reach
the isolated server to exchange the code. Supply a run-local `FIRST_TREE_SERVER_URL` to the CLI runner process, outside
the copied bootstrap text, while leaving the server's canonical public URL in place so issuer validation and the emitted
hosted command remain representative. Record this routing override as QA harness configuration, not product output.

For recovery fault injection, run a separate candidate server instance for each channel, or restart and reset the
isolated channel stack, with `FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL` set to the controlled mirror origin. Mint new connect
codes from that server for every failure and success attempt. The resulting custom-base command is product output and
must retain the same temporary-file, cleanup, and `&&` guard structure; it should pass the custom base to the downloaded
installer as generated by the server. Never edit the copied command to insert a harness-side success guard.

## Operate

For each of `prod` and `staging`:

- Start the candidate server/web stack with the matching `FIRST_TREE_CHANNEL`, create a throwaway authenticated user, and
  enter a fresh-computer connection flow in the web UI. Exercise onboarding or **Computers -> New Connection**; when the
  new-agent no-computer path is available, confirm it presents the same server-supplied bootstrap rather than building a
  different command.
- Capture the `POST /api/v1/me/connect-tokens` response and the command copied from the UI. Compare them byte-for-byte
  after redacting the connect code in shared evidence. The UI copy must equal `bootstrapCommand`; `installerUrl`,
  `binName`, and the standalone installed-CLI `command` must all describe the same channel.
- Fetch the public `install.sh` separately for HTTP status and `sh -n` evidence. The default latest install path reads
  `latest.json` directly and downloads the matching platform asset from that document; record its channel, version,
  binary name, asset URL, and checksum. Independently fetch the immutable manifest referenced by `manifestUrl` and that
  version's `SHA256SUMS`, then cross-check their identity and checksum data without modifying public objects. Do not
  report the manifest or `SHA256SUMS` as files consumed by the installer itself.
- In the clean CLI runner, execute the exact copied guarded bootstrap once. The only harness addition is the externally
  supplied run-local `FIRST_TREE_SERVER_URL` needed to route the login to the isolated server. Do not rewrite the
  installer URL, binary path, connect code, or command lines, and do not append `--no-start`.
- Observe the installed executable and the isolated server after login. Use current black-box CLI/API surfaces to confirm
  the client registration belongs to the throwaway user and was created by the channel-correct binary.
- Prepare the recovery runner from a recorded immutable older release of the same channel. Put a thin executable wrapper
  at the normal `~/.local/bin` path that records invocation without arguments and then delegates to that older binary, so
  an unsafe fallthrough would be both observable and capable of consuming the new code and reconnecting. Record the
  wrapper hash, installed version, client list, and service state before fault injection; do not log the connect code.
- Point the recovery server at the controlled mirror, mint a fresh code, force the outer `install.sh` request to fail
  with a deterministic HTTP error before writing a usable response, and run the exact server-supplied command under
  POSIX `sh` without `pipefail`. First record the direct `curl -fsSL` status for the same response; require the complete
  bootstrap to return that exact status, with no stale-wrapper invocation, an unchanged wrapper hash, no
  new/reconnected client, and no leaked `first-tree-install.*` temporary file.
- Mint another fresh code and allow the outer `install.sh` fetch to succeed, but use the genuine channel installer with a
  deterministic downstream failure such as a checksum mismatch or unavailable portable asset. Require a non-zero
  installer status, require the complete bootstrap to return that same status, and make the same no-invocation,
  unchanged-wrapper, no-client, and temporary-file cleanup observations. Do not substitute a harness script that merely
  pretends to be the installer for this step.
- Restore every mirrored object to the recorded valid channel release, mint a third fresh code, and execute the newly
  supplied command from the same recovery home. Require the installer to replace or repair the stale installation before
  login runs, then verify the repaired channel binary completes login, starts the real user service, and creates the
  expected client. The stale-wrapper invocation marker must remain absent throughout all three attempts.

## Observe

- `observe browser-ui`: every exercised web entry point displays and copies the server response exactly. There is no npm
  install step, Node.js fallback, `curl | sh` pipeline, or PATH-dependent bare login command.
- `observe http-api`: prod returns the prod installer URL, `first-tree`, and the exact prod guarded bootstrap. Staging
  returns the staging installer URL, `first-tree-staging`, and the exact staging guarded bootstrap. Each command downloads
  to a temporary file and places installer execution plus full-path login in one `&&` chain. The connect code appears only
  in the login command, never in `installerUrl` or public download requests.
- `observe public-http`: both public installers return successfully and pass `sh -n`; each default install reads its
  channel's `latest.json` asset and verifies that tarball's checksum. As a separate consistency check, the referenced
  immutable manifest and versioned `SHA256SUMS` agree with the latest metadata and downloaded asset.
- `observe filesystem`: from a fresh home, the installer creates `~/.local/bin/first-tree` for prod or
  `~/.local/bin/first-tree-staging` for staging. The full path in the second line works immediately without sourcing a
  shell profile, and installed metadata identifies the matching channel and portable install mode.
- `observe recovery-failure`: under plain POSIX `sh`, each complete bootstrap returns the recorded status of its failed
  fetch or installer, removes the downloaded temporary installer, leaves the stale wrapper byte-for-byte unchanged and
  uninvoked, and leaves server client/connection state unchanged. A fetch failure must not be masked by `sh` reading an
  empty pipeline because no pipeline is used.
- `observe recovery-success`: after the mirror is restored, the same installer entry point replaces or repairs the stale
  channel installation, and only that repaired binary receives `login`. Its metadata matches the recorded mirrored
  release, while the stale-wrapper marker remains absent.
- `observe cli-output`: the installed executable launches with its bundled Node.js runtime and the first `login` exits
  successfully against the isolated server without `--no-start`.
- `observe service-state`: the login installs and starts the channel-correct systemd user service, and
  `systemctl --user` reports it active through the runner's real user manager and bus.
- `observe http-api`: the isolated server reports the newly registered client for the throwaway user after login. Prod
  and staging homes/clients stay isolated; neither flow invokes the other channel's binary.

Follow current typed response and installed-metadata schemas if field names evolve, but keep the evidence tied to the
same cross-surface claims. Do not treat source inspection, unit-test output, or a successful installer download alone as
proof that first login worked.

## Expected Result

`PASS`: both prod and staging web/API flows supplied the exact hosted guarded command, each live public installer resolved
and installed its matching channel artifact in a clean Node-free runner, and both recovery runners preserved fetch and
installer failures without invoking or reconnecting through their stale binary. After valid mirror service resumed, each
installer repaired the channel installation before the full-path binary completed login with its background service
active, and the isolated server observed a client only for the successful attempts.

`FAIL`: a reproducible product defect, such as web copy diverging from `bootstrapCommand`, an npm/Node fallback appearing,
the public URL or metadata crossing channels, the expected full-path binary being absent, a bundled-runtime launch
failure, daemon installation/start failing despite a healthy user manager and bus, a valid fresh connect code failing to
register against a healthy isolated server, a failed fetch/installer returning success, the stale wrapper being invoked
or changed during failure, or any client appearing/reconnecting before a verified installation succeeds.

`BLOCKED`: Docker or public download access is unavailable, QA auth/data bootstrap cannot mint a connect code, or a
required public channel release or suitable previous compatible release has not been published. An unavailable isolated
fault server/mirror also blocks the recovery portion. A Linux runner without a reachable systemd user manager and D-Bus
user session is also `BLOCKED`; do not downgrade this case to `login --no-start`.

`INCONCLUSIVE`: only one channel or one recovery mode completed, the mutable public installer changed during the run, the
public artifact could not be attributed to the recorded metadata/version, or login/reconnection evidence was partial or
unstable.

## Evidence

Keep redacted API responses, browser screenshots plus clipboard capture, installer, latest metadata, immutable-manifest,
and `SHA256SUMS` HTTP responses, `sh -n` output, checksum/install logs, installed binary/version/channel evidence, CLI
login output, systemd user-service state, and the server-side client registration. For recovery, also retain fault-server
request logs, exact non-zero statuses, redacted command shapes, temporary-directory listings, stale-wrapper hashes and
invocation markers, and before/after server client snapshots. Record target ref, public artifact versions, previous
compatible versions, container image digests, and run-local routing overrides. Never retain connect codes, bearer tokens,
cookies, or generated client credentials in shared artifacts.
