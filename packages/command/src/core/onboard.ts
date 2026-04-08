import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG_DIR, DEFAULT_HOME_DIR, setConfigValue } from "@first-tree-hub/shared/config";
import { bootstrapToken, getGitHubUsername, resolveServerUrl } from "./bootstrap.js";

// ── Types ────────────────────────────────────────────────────────────

type OnboardArgs = {
  id: string;
  type: "human" | "personal_assistant" | "autonomous_agent";
  role?: string;
  domains?: string;
  displayName?: string;
  profile?: string;
  assistant?: string;
  delegateMention?: string;
  server?: string;
  feishuBotAppId?: string;
  feishuBotAppSecret?: string;
};

type CheckItem = {
  key: string;
  label: string;
  status: "ok" | "missing_required" | "missing_optional" | "warning" | "error";
  value?: string;
  hint?: string;
};

export const STATE_FILE = join(DEFAULT_HOME_DIR, ".onboard-state.json");

/** Save current onboard args to state file for resume. */
export function saveOnboardState(args: Record<string, unknown>): void {
  mkdirSync(DEFAULT_HOME_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify({ args }, null, 2));
}

/** Load saved onboard args from state file. */
export function loadOnboardState(): Record<string, unknown> | null {
  try {
    const data = JSON.parse(readFileSync(STATE_FILE, "utf-8")) as { args: Record<string, unknown> };
    return data.args;
  } catch {
    return null;
  }
}

// ── Check mode ───────────────────────────────────────────────────────

export async function onboardCheck(args: OnboardArgs): Promise<CheckItem[]> {
  const items: CheckItem[] = [];

  // GitHub CLI — check first, everything else depends on it
  let ghUsername: string | null = null;
  try {
    ghUsername = getGitHubUsername();
    items.push({ key: "github_cli", label: "GitHub CLI", status: "ok", value: `authenticated as ${ghUsername}` });
  } catch {
    items.push({
      key: "github_cli",
      label: "GitHub CLI",
      status: "missing_required",
      hint: "Install and authenticate: gh auth login",
    });
  }

  // Server URL
  try {
    const serverUrl = resolveServerUrl(args.server);
    items.push({ key: "server", label: "Server URL", status: "ok", value: serverUrl });

    // Check server reachable
    try {
      const res = await fetch(`${serverUrl}/api/v1/health`);
      items.push({
        key: "server_reachable",
        label: "Server reachable",
        status: res.ok ? "ok" : "error",
        value: res.ok ? "healthy" : `HTTP ${res.status}`,
      });
    } catch {
      items.push({
        key: "server_reachable",
        label: "Server reachable",
        status: "error",
        hint: "Cannot connect to server",
      });
    }
  } catch {
    items.push({
      key: "server",
      label: "Server URL",
      status: "missing_required",
      hint: "Provide via --server, FIRST_TREE_HUB_SERVER, or config",
    });
  }

  // Required params
  if (args.id) {
    items.push({ key: "id", label: "Agent ID", status: "ok", value: args.id });
  } else {
    items.push({ key: "id", label: "Agent ID", status: "missing_required", hint: "Provide via --id" });
  }

  if (args.type) {
    items.push({ key: "type", label: "Agent type", status: "ok", value: args.type });
  } else {
    items.push({ key: "type", label: "Agent type", status: "missing_required", hint: "Provide via --type" });
  }

  return items;
}

export function formatCheckReport(items: CheckItem[]): string {
  const lines: string[] = [];
  for (const item of items) {
    const icon =
      item.status === "ok"
        ? "\u2705"
        : item.status === "missing_required"
          ? "\u274C"
          : item.status === "error"
            ? "\u274C"
            : item.status === "warning"
              ? "\u26A0\uFE0F"
              : "\u2B1C";
    const valueStr = item.value ? `  ${item.value}` : "";
    const hintStr = item.hint ? `  (${item.hint})` : "";
    lines.push(`  ${icon} ${item.label.padEnd(20)}${valueStr}${hintStr}`);
  }
  return lines.join("\n");
}

// ── Create agent via bootstrap endpoint ─────────────────────────────

export async function onboardCreate(args: OnboardArgs): Promise<void> {
  const serverUrl = resolveServerUrl(args.server).replace(/\/+$/, "");
  getGitHubUsername(); // verify gh is authenticated (throws if not)

  // 1. Bootstrap token for the main agent (auto-creates if not exists)
  process.stderr.write(`Bootstrapping agent "${args.id}"...\n`);

  // Build metadata from role/domains if provided
  const metadata: Record<string, unknown> = {};
  if (args.role) metadata.role = args.role;
  if (args.domains) metadata.domains = args.domains.split(",").map((d) => d.trim());

  let token: string;
  try {
    const result = await bootstrapToken(serverUrl, args.id, {
      saveTo: "agent",
      type: args.type,
      displayName: args.displayName ?? args.id,
      profile: args.profile,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    });
    token = result.token;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("already has") || msg.includes("409")) {
      throw new Error(
        `Agent "${args.id}" already has an active token.\n` +
          "Ask an admin to revoke the existing token in the Web UI, then re-run onboard.",
      );
    }
    throw err;
  }
  process.stderr.write(`Agent "${args.id}" ready.\n`);

  // 2. Bootstrap assistant if requested (auto-creates if not exists)
  if (args.assistant) {
    process.stderr.write(`Bootstrapping assistant "${args.assistant}"...\n`);
    try {
      const assistantResult = await bootstrapToken(serverUrl, args.assistant, { saveTo: "agent" });
      token = assistantResult.token; // use assistant token for Feishu binding
      process.stderr.write(`Assistant "${args.assistant}" ready.\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Warning: Failed to bootstrap assistant "${args.assistant}": ${msg}\n`);
    }
  }

  const agentToBootstrap = args.assistant ?? args.id;
  process.stderr.write(`Token saved to ${DEFAULT_HOME_DIR}/config/agents/${agentToBootstrap}/agent.yaml\n`);

  // 3. Bind Feishu bot (if requested)
  if (args.feishuBotAppId && args.feishuBotAppSecret) {
    const { bindFeishuBot } = await import("./feishu.js");
    process.stderr.write("Binding Feishu bot...\n");
    await bindFeishuBot(serverUrl, token, args.feishuBotAppId, args.feishuBotAppSecret);
    process.stderr.write("Feishu bot bound.\n");
  }

  // 4. Auto-configure client config
  const clientConfigPath = join(DEFAULT_CONFIG_DIR, "client.yaml");
  setConfigValue(clientConfigPath, "server.url", serverUrl);

  // Clean up state file
  try {
    const { unlinkSync } = await import("node:fs");
    unlinkSync(STATE_FILE);
  } catch {
    // Ignore
  }

  // Summary
  const typeLabel = args.type === "human" ? "Human" : args.type === "autonomous_agent" ? "Agent" : "Assistant";
  process.stderr.write("\n\u2705 Onboard complete!\n\n");
  process.stderr.write(`  ${typeLabel}:${" ".repeat(Math.max(1, 10 - typeLabel.length))}${args.id}\n`);
  if (args.assistant) {
    process.stderr.write(`  Assistant: ${args.assistant}\n`);
  }
  process.stderr.write(`  Token:     ${DEFAULT_HOME_DIR}/config/agents/${agentToBootstrap}/agent.yaml\n`);
  if (args.feishuBotAppId) {
    process.stderr.write(`  Feishu:    bot bound (${args.feishuBotAppId})\n`);
  }

  if (args.type === "human") {
    process.stderr.write("\n  Next step \u2014 bind your Feishu account:\n");
    process.stderr.write(`    Send this message to the bot in Feishu:  /bind ${args.id}\n`);
    if (!args.feishuBotAppId) {
      process.stderr.write("    (requires a Feishu bot to be configured in the system)\n");
    }
  }

  process.stderr.write("\n  Start the agent:\n");
  process.stderr.write("    first-tree-hub client start\n");
  process.stderr.write("\n");
}
