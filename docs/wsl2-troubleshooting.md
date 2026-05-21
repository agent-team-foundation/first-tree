# WSL2 Troubleshooting

Known issues that only occur on WSL2 (and their fixes). If you are not on
WSL2, skip this doc.

## `first-tree-hub daemon start` fails with "Failed to connect to bus"

Symptom — after rebooting Windows, the very first `first-tree-hub client
start` reports:

```
Failed to start service: Failed to connect to bus: No such file or directory
Try `--foreground` to run inline instead.
```

`systemctl --user status` reports the same `Failed to connect to bus`.

### Root cause

WSL2 + WSLg layers two `tmpfs` mounts at `/run/user/1000`:

| layer | mode | what it contains | who creates it |
|-------|------|------------------|----------------|
| bottom | `0700` (owner `uid=1000`) | systemd-managed `bus`, `systemd/private`, `systemd/notify`, `gnupg/`, ... | `systemd-user-runtime-dir@1000.service` at boot |
| top    | `0755` (owner `root`)     | `wayland-0` symlink (so Linux GUI apps can find WSLg's Wayland socket), `dbus-1/`, `pulse/` | WSLg, mounted shortly after systemd starts |

The top `tmpfs` over-mounts the bottom one, so any user-space tool (your
shell, `systemctl --user`, the `first-tree-hub` CLI) only sees the WSLg
overlay. The systemd user manager is happily listening on
`/run/user/1000/bus` in the bottom layer (verifiable with `ss -lxp`), but
no client can reach it because the path resolves to the empty WSLg
overlay instead.

Effect: `systemctl --user` always fails with `Failed to connect to bus`,
even though the `first-tree-hub-client.service` unit may already be
running fine — `systemd` itself was started before the over-mount and
has the right view.

### Quick fix (one-off, after every reboot)

```bash
sudo umount -l /run/user/$(id -u)   # lazy unmount; existing fds keep working
ls /run/user/$(id -u)/              # should now show: bus  gnupg  systemd  ...
systemctl --user status             # should now succeed
first-tree-hub daemon start
```

`umount -l` (lazy) is required — a plain `umount` always reports
`target is busy` because VS Code, Wayland, and PulseAudio hold open
sockets inside that mount. Lazy unmount detaches the over-mount from the
namespace immediately while letting existing fds keep working.

### Permanent fix

Two steps. Do them once per machine.

**1) Install a helper script** that waits for the WSLg overlay to appear
and lazy-unmounts it. The wait is necessary because the overlay is added
some seconds *after* WSL boot, so a naive `umount -l` in `wsl.conf`'s
`command=` runs too early and silently no-ops.

```bash
sudo tee /usr/local/bin/strip-wslg-overlay.sh > /dev/null <<'EOF'
#!/bin/sh
# Wait up to 30s for WSLg's mode=755 overlay on /run/user/<uid>, then
# lazy-umount it so systemd's user-bus socket underneath becomes visible
# to user-space (fixes `systemctl --user` -> "Failed to connect to bus").
# Loops over every numeric /run/user/* so multi-user WSL distros also work.
for d in /run/user/*; do
  case "${d##*/}" in ''|*[!0-9]*) continue ;; esac
  for i in $(seq 1 30); do
    if mount | grep -q "tmpfs on $d .*mode=755"; then
      umount -l "$d"
      logger -t strip-wslg-overlay "stripped $d after ${i}s"
      break
    fi
    sleep 1
  done
done
EOF
sudo chmod +x /usr/local/bin/strip-wslg-overlay.sh
```

**2) Wire it into `/etc/wsl.conf`** so WSL runs it once per boot, as
root, after systemd has started:

```ini
[boot]
systemd=true
command=/usr/local/bin/strip-wslg-overlay.sh

[user]
default=<your-username>
```

Keep your existing `[user]` block; only `command=...` is new.

**3) Restart WSL and verify** (run in Windows PowerShell, then reopen
the terminal):

```powershell
wsl --shutdown
```

```bash
mount | grep "/run/user/$(id -u)"
# Expect a single `mode=700` line — the overlay is gone.

ls /run/user/$(id -u)/
# Expect: bus  gnupg  pk-debconf-socket  snapd-session-agent.socket  systemd

journalctl -t strip-wslg-overlay --no-pager
# Expect: "stripped overlay after Ns" (typically 1–10s).

systemctl --user status first-tree-hub-client --no-pager | head -5
# Expect: Active: active (running)
```

### Trade-offs

Removing the overlay also removes the `/run/user/1000/wayland-0`
symlink, which means **Linux-side Wayland/X11 GUI apps lose access to
WSLg** (Windows-side VS Code / Chrome / terminal are unaffected).

Most WSL users never launch Linux GUI apps, so this is fine. If you do,
extend the script to re-create the symlink on the bottom layer after
unmounting:

```sh
# Inside the for-d loop in strip-wslg-overlay.sh, right after `umount -l "$d"`:
uid=${d##*/}
ln -sf /mnt/wslg/runtime-dir/wayland-0      "$d/wayland-0"
ln -sf /mnt/wslg/runtime-dir/wayland-0.lock "$d/wayland-0.lock"
chown -h "$uid:$uid" "$d/wayland-0" "$d/wayland-0.lock"
```

### Why not just `--foreground`?

`first-tree-hub daemon start --foreground` skips the service manager
entirely and runs the client inline. That works for debugging but loses
the systemd supervision: no auto-restart, no boot-time start via
`loginctl enable-linger`, no clean separation from your shell. Use the
permanent fix above instead.
