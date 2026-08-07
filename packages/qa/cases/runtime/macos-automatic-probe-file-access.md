---
id: macos-automatic-probe-file-access
description: Validate that automatic provider discovery on macOS reaches no TCC-protected folder while still finding login-shell-only installs.
areas: [runtime]
surfaces: [cli]
---

# macOS Automatic Probe File Access

## Goal

Verify two properties of automatic provider discovery on macOS at the same time, because either one alone can be
satisfied by breaking the other:

1. Startup, reconnect, and background capability refresh never read inside a TCC-protected folder — Desktop, Documents,
   Downloads, iCloud Drive, or a cloud File Provider mount — so a user who has chosen nothing yet is never asked for
   Files & Folders consent, and is never told to grant Full Disk Access.
2. A provider installed only on the user's interactive login-shell `PATH` (nvm, fnm, volta, mise, asdf, a custom
   `export PATH=`) is still discovered.

Use this case when a task changes provider discovery, the login-shell `PATH` probe, daemon startup/reconnect, or the
Codex external-Context project classifier.

## Preconditions

- Run on macOS, in the isolated QA run cell selected by the plan, under a user account whose TCC decisions for the
  runtime binary have not already been granted. A machine that previously approved these folders cannot answer property 1.
- Install one provider so that it is reachable ONLY from the interactive login shell — e.g. `npm i -g` under nvm or fnm,
  with the version-manager init line in `~/.zshrc` and not in the daemon's service `PATH`. Prefer fnm with
  `--use-on-cd`, because that puts a per-session symlink on `$PATH` that disappears with the shell: discovery must come
  from the version manager's stable install dir, not from that link.
- Put a wildcard entry on the login-shell `PATH` too (for example `$HOME/Documents/*`), since an unquoted expansion can
  enumerate a protected folder without any explicit directory access.
- Add protected directories to the login-shell `PATH` in all three ways they can be reached, because a guard can close
  one and leave the others open:
  - by spelling — `$HOME/Documents/bin`;
  - as a symlinked entry — `$HOME/bin` symlinked to `$HOME/Documents/bin`;
  - through a symlinked ancestor — `$HOME/deep/mid/bin`, where `$HOME/deep/mid` is symlinked to `$HOME/Documents`.

## Operate

1. Install and start the daemon, then leave it connected and idle long enough for the degraded-capability refresh to run
   several times.
2. Disconnect the network, reconnect, and let the reconnect re-probe run.
3. Run the on-demand probe: `first-tree daemon probe --json --no-upload`.
4. If external Codex Context is enabled in the run cell, start a Codex session from an ordinary project directory that is
   NOT under `~/Documents`.

Record the exact commands, the daemon version under test, and the shell used.

## Observe

- Whether macOS presented any Files & Folders consent prompt at any point in steps 1-4.
- Whether the runtime process read inside a protected folder — observe with a filesystem trace (for example `fs_usage`
  filtered to the runtime process) or the TCC decision log for the run window, not by prompt appearance alone, since a
  prompt is suppressed once a decision exists.
- The capability entry for the login-shell-only provider in the probe output: state, `runtimeSource`, and `runtimePath`.
- When the provider is under a version manager, whether `runtimePath` points at the version the shell actually selected.
  It must never silently be a different installed version: with several fnm versions installed and the per-session link
  already gone, "not found" is the correct answer, not the newest one.
- For step 4, whether the process touched `~/Documents` at all.

## Expected Result

`PASS` means no consent prompt appeared and the trace shows zero reads inside a protected folder across idle, reconnect,
and on-demand probe, AND the login-shell-only provider was still reported installed with a usable path.

`FAIL` means either half broke: a protected folder was read (or consent requested) without the user selecting anything,
or the login-shell-only provider was reported missing while its selected version was still resolvable. Report which half
failed — they have different fixes. A resolved path pointing at a version the shell did NOT select is also a `FAIL`,
and a more serious one than a miss.

`BLOCKED` means the run cell is not macOS, the account already carries TCC decisions for the runtime binary, or no
filesystem tracing is available, so property 1 cannot be observed.

`INCONCLUSIVE` means tracing was partial, the protected `PATH` entry was never actually on the login-shell `PATH`, or the
observation cannot be attributed to the target ref.

## Evidence

Keep the trace excerpt for the run window, the probe JSON entry for the login-shell-only provider, the login-shell `PATH`
as the shell reports it, and the macOS version. Redact home-directory contents and any provider credentials; record
directory paths only, never file listings.
