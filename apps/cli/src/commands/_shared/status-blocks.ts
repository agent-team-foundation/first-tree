import { existsSync } from "node:fs";
import { join } from "node:path";
import { agentConfigSchema, defaultConfigDir, loadAgents, readConfigFile } from "@first-tree/shared/config";
import { loadCredentials } from "../../core/bootstrap.js";
import { channelConfig } from "../../core/channel.js";
import { errorMessage } from "../../core/error-message.js";
import { print } from "../../core/output.js";
import { getClientServiceStatus, isServiceSupported } from "../../core/service-install.js";
import { COMMAND_VERSION } from "../../core/version.js";

/**
 * Shared render blocks for the cross-subsystem `status` view (top-level
 * `status` command + daemon-scoped `daemon status`). Extracted from the
 * pre-split `client status` (legacy `commands/client.ts:407–496`) so both
 * surfaces reuse the same formatting without duplicating I/O.
 */

export function renderCliVersionBlock(): void {
  // CLI version. Drift check (npm registry) is intentionally NOT run here —
  // `status` should be fast (< 1s, no network). Use `<bin> upgrade --check` instead.
  print.line(`  CLI:      ${COMMAND_VERSION}\n`);
}

export function renderServiceBlock(): void {
  if (!isServiceSupported()) {
    print.line(`  Service:  not supported on ${process.platform} (runs inline)\n`);
    return;
  }
  const svc = getClientServiceStatus();
  const tail = `  (logs: ${join(svc.logDir, "client.log")})`;
  if (svc.state === "active") {
    print.line(`  Service:  ✓ running (${svc.platform}${svc.detail ? `, ${svc.detail}` : ""})${tail}\n`);
  } else if (svc.state === "inactive") {
    print.line(`  Service:  ✗ stopped (${svc.platform}${svc.detail ? `, ${svc.detail}` : ""})\n`);
  } else if (svc.state === "not-installed") {
    print.line(`  Service:  not installed — run \`${channelConfig.binName} login <code>\`\n`);
  } else {
    print.line(`  Service:  unknown (${svc.platform}${svc.detail ? `, ${svc.detail}` : ""})\n`);
  }
}

export function renderHubBlock(): void {
  const clientYaml = join(defaultConfigDir(), "client.yaml");
  if (!existsSync(clientYaml)) {
    print.line(`  Server:   (not configured — run \`${channelConfig.binName} login <code>\`)\n`);
    return;
  }
  try {
    const cfg = readConfigFile(clientYaml);
    const serverUrl = getNested(cfg, "server.url");
    const clientId = getNested(cfg, "client.id");
    print.line(`  Server:   ${serverUrl ?? "(not configured)"}\n`);
    print.line(`  Client:   ${clientId ?? "(not configured)"}\n`);
  } catch (err) {
    const msg = errorMessage(err);
    print.line(`  Server:   (could not read ${clientYaml}: ${msg.slice(0, 60)})\n`);
  }
}

export function renderAuthBlock(): void {
  // Local-only check on the persisted refresh token's `exp` claim. Mirrors
  // the supervisor's reality: a "running" service whose refresh token is
  // past expiry is just looping at 1Hz on `/auth/refresh` and will never
  // come back online without operator action. Done locally (not via `/me`)
  // to keep this command < 1s and offline-safe.
  const creds = loadCredentials();
  if (!creds) {
    print.line(`  Auth:     (no credentials — run \`${channelConfig.binName} login <code>\`)\n`);
    return;
  }
  const exp = decodeJwtExpSeconds(creds.refreshToken);
  if (exp == null) {
    print.line("  Auth:     ⚠ could not parse refresh token (corrupt credentials)\n");
    return;
  }
  const remainingSec = exp - Math.floor(Date.now() / 1000);
  if (remainingSec <= 0) {
    print.line(`  Auth:     ✗ refresh token EXPIRED — re-run \`${channelConfig.binName} login <code>\`\n`);
    print.line("              (get a fresh token from the First Tree web console → Computers → New Connection)\n");
  } else if (remainingSec < 2 * 86400) {
    const hours = Math.floor(remainingSec / 3600);
    print.line(`  Auth:     ⚠ refresh token expires in ~${hours}h — re-login soon to stay online\n`);
  } else {
    const days = Math.floor(remainingSec / 86400);
    print.line(`  Auth:     ✓ refresh token valid for ~${days}d\n`);
  }
}

export function renderAgentsBlock(): void {
  const agentsDir = join(defaultConfigDir(), "agents");
  try {
    const agents = loadAgents({ schema: agentConfigSchema, agentsDir });
    if (agents.size === 0) {
      print.line("  Agents:   0 configured\n\n");
      return;
    }
    print.line(`  Agents:   ${agents.size} configured\n\n`);
    for (const [name, config] of agents) {
      print.line(`    ${name.padEnd(20)} runtime: ${config.runtime.padEnd(14)} agentId: ${config.agentId}\n`);
    }
    print.line("\n");
  } catch {
    print.line("  Agents:   (no agents directory)\n\n");
  }
}

/** Read a `dot.path.like.this` from a parsed YAML object, returning string | null. */
function getNested(obj: Record<string, unknown>, path: string): string | null {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === "string" ? cur : null;
}

/**
 * Pull the `exp` claim (in seconds since epoch) out of a JWT without
 * verifying the signature — the auth-health line only needs the wall-clock
 * countdown, not a trust decision. Returns null for malformed tokens so the
 * caller can render a friendly fallback instead of crashing.
 */
function decodeJwtExpSeconds(token: string): number | null {
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
    const payload = JSON.parse(Buffer.from(b64 + pad, "base64").toString("utf-8")) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}
