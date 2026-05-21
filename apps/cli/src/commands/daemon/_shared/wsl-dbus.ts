import { readFileSync } from "node:fs";

/**
 * WSL2 + WSLg over-mounts a mode=755 tmpfs onto /run/user/$UID, hiding the
 * systemd user-bus socket beneath. `systemctl --user` then fails with
 * "Failed to connect to bus: No such file or directory" even though the
 * user manager is happily running. See docs/wsl2-troubleshooting.md.
 */
export function isWslDbusOvermount(reason: string): boolean {
  if (process.platform !== "linux") return false;
  if (!/failed to connect to bus/i.test(reason)) return false;
  try {
    return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}
