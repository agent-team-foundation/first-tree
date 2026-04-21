/**
 * macOS launchd integration for the gardener daemon.
 *
 * Separate from breeze's launchd module (same pattern, different
 * label/plist path) so the two products can be started, stopped, and
 * diagnosed independently. On non-darwin callers fall back to a
 * detached `spawn(...)` — see `commands/start.ts`.
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface LaunchdPlistInputs {
  label: string;
  executable: string;
  arguments: readonly string[];
  logPath: string;
  env?: Record<string, string | undefined>;
  workingDirectory?: string;
}

export function supportsLaunchd(): boolean {
  if (process.platform !== "darwin") return false;
  try {
    execSync("command -v launchctl", { stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

export function sanitizeLabelSegment(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function gardenerLaunchdLabel(login: string): string {
  return `com.first-tree.gardener.${sanitizeLabelSegment(login)}`;
}

export function gardenerLaunchdPlistPath(
  gardenerDir: string,
  label: string,
): string {
  return join(gardenerDir, "launchd", `${label}.plist`);
}

export function launchdUserDomain(): string {
  const result = spawnSync("id", ["-u"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `resolve user id for launchd failed: ${result.stderr?.trim() ?? ""}`,
    );
  }
  const uid = (result.stdout ?? "").split("\n")[0]?.trim();
  if (!uid) throw new Error("could not resolve numeric user id for launchd");
  return `gui/${uid}`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function renderLaunchdPlist(
  inputs: LaunchdPlistInputs,
): string {
  const argv = [inputs.executable, ...inputs.arguments];
  const programArguments = argv
    .map((a) => `    <string>${escapeXml(a)}</string>`)
    .join("\n");
  const envEntries = Object.entries(inputs.env ?? {})
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(
      ([k, v]) =>
        `    <key>${escapeXml(k)}</key>\n    <string>${escapeXml(v)}</string>`,
    )
    .join("\n");
  const envBlock =
    envEntries.length > 0
      ? `  <key>EnvironmentVariables</key>\n  <dict>\n${envEntries}\n  </dict>\n`
      : "";
  const workingDir = inputs.workingDirectory
    ? `  <key>WorkingDirectory</key>\n  <string>${escapeXml(inputs.workingDirectory)}</string>\n`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(inputs.label)}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(inputs.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(inputs.logPath)}</string>
${workingDir}${envBlock}</dict>
</plist>
`;
}

export interface BootstrapInputs extends LaunchdPlistInputs {
  plistPath: string;
}

export function bootstrapLaunchdJob(inputs: BootstrapInputs): {
  plistPath: string;
  label: string;
} {
  mkdirSync(dirname(inputs.plistPath), { recursive: true });
  mkdirSync(dirname(inputs.logPath), { recursive: true });
  writeFileSync(inputs.plistPath, renderLaunchdPlist(inputs));
  const domain = launchdUserDomain();
  // Boot out any prior instance first (idempotent). Ignore errors.
  spawnSync("launchctl", ["bootout", `${domain}/${inputs.label}`], {
    stdio: "ignore",
  });
  const bootstrap = spawnSync("launchctl", ["bootstrap", domain, inputs.plistPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (bootstrap.status !== 0) {
    throw new Error(
      `launchctl bootstrap failed: ${bootstrap.stderr?.trim() ?? "exit " + bootstrap.status}`,
    );
  }
  return { plistPath: inputs.plistPath, label: inputs.label };
}

export function booteLaunchdJob(label: string, plistPath: string): void {
  const domain = launchdUserDomain();
  spawnSync("launchctl", ["bootout", `${domain}/${label}`], { stdio: "ignore" });
  if (existsSync(plistPath)) {
    try {
      unlinkSync(plistPath);
    } catch {
      // best-effort; ignore
    }
  }
}
