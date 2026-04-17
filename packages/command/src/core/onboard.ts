import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_CONFIG_DIR,
  DEFAULT_HOME_DIR,
  setConfigValue,
} from "@agent-team-foundation/first-tree-hub-shared/config";
import { ensureFreshAccessToken, loadCredentials, resolveServerUrl, saveAgentConfig } from "./bootstrap.js";

// ── Types ────────────────────────────────────────────────────────────

type OnboardArgs = {
  id: string;
  type: "human" | "personal_assistant" | "autonomous_agent";
  clientId?: string;
  role?: string;
  domains?: string;
  displayName?: string;
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

  const creds = loadCredentials();
  if (creds) {
    items.push({ key: "connect", label: "Signed in", status: "ok", value: creds.serverUrl });
  } else {
    items.push({
      key: "connect",
      label: "Signed in",
      status: "missing_required",
      hint: "Run `first-tree-hub connect <server-url>` first",
    });
  }

  try {
    const serverUrl = resolveServerUrl(args.server);
    items.push({ key: "server", label: "Server URL", status: "ok", value: serverUrl });

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
      hint: "Provide via --server, FIRST_TREE_HUB_SERVER_URL, or config",
    });
  }

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

  if (args.type && args.type !== "human" && !args.clientId) {
    items.push({
      key: "client",
      label: "Target client",
      status: "missing_required",
      hint: "Non-human agents must pin a client via --client-id <id>",
    });
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

// ── Create flow ──────────────────────────────────────────────────────

async function createAgentViaAdmin(
  serverUrl: string,
  accessToken: string,
  body: Record<string, unknown>,
): Promise<{ uuid: string; name: string | null }> {
  const res = await fetch(`${serverUrl}/api/v1/admin/agents`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(errBody.error ?? `Failed to create agent (HTTP ${res.status})`);
  }
  return (await res.json()) as { uuid: string; name: string | null };
}

export async function onboardCreate(args: OnboardArgs): Promise<void> {
  const serverUrl = resolveServerUrl(args.server).replace(/\/+$/, "");
  const accessToken = await ensureFreshAccessToken();

  const metadata: Record<string, unknown> = {};
  if (args.role) metadata.role = args.role;
  if (args.domains) metadata.domains = args.domains.split(",").map((d) => d.trim());

  process.stderr.write(`Creating agent "${args.id}"...\n`);
  const primary = await createAgentViaAdmin(serverUrl, accessToken, {
    name: args.id,
    type: args.type,
    displayName: args.displayName ?? args.id,
    delegateMention: args.assistant ?? args.delegateMention,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    clientId: args.type === "human" ? undefined : args.clientId,
  });
  process.stderr.write(`Agent "${args.id}" created (uuid ${primary.uuid}).\n`);

  // For non-human agents, persist the local alias so `client start` can bind.
  if (args.type !== "human") {
    saveAgentConfig(args.id, primary.uuid, "claude-code");
  }

  let assistantUuid: string | null = null;
  if (args.assistant) {
    process.stderr.write(`Creating assistant "${args.assistant}"...\n`);
    try {
      const assistant = await createAgentViaAdmin(serverUrl, accessToken, {
        name: args.assistant,
        type: "personal_assistant",
        displayName: args.assistant,
        metadata: { role: `Personal Assistant to ${args.id}`, domains: ["message triage", "task coordination"] },
        clientId: args.clientId,
      });
      assistantUuid = assistant.uuid;
      saveAgentConfig(args.assistant, assistant.uuid, "claude-code");
      process.stderr.write(`Assistant "${args.assistant}" ready.\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Warning: Failed to create assistant "${args.assistant}": ${msg}\n`);
    }
  }

  const runtimeAgent = args.type === "human" ? args.assistant : args.id;

  // Bind Feishu bot if requested — runs on the runtime agent (assistant for
  // human, otherwise self).
  if (args.feishuBotAppId && args.feishuBotAppSecret) {
    const { bindFeishuBot } = await import("./feishu.js");
    const targetAgentUuid = args.type === "human" ? assistantUuid : primary.uuid;
    if (!targetAgentUuid) {
      process.stderr.write(`Warning: Cannot bind Feishu bot — no runtime agent available for "${args.id}".\n`);
    } else {
      process.stderr.write("Binding Feishu bot...\n");
      await bindFeishuBot(serverUrl, accessToken, targetAgentUuid, args.feishuBotAppId, args.feishuBotAppSecret);
      process.stderr.write("Feishu bot bound.\n");
    }
  }

  const clientConfigPath = join(DEFAULT_CONFIG_DIR, "client.yaml");
  setConfigValue(clientConfigPath, "server.url", serverUrl);

  try {
    const { unlinkSync } = await import("node:fs");
    unlinkSync(STATE_FILE);
  } catch {
    // Ignore
  }

  const typeLabel = args.type === "human" ? "Human" : args.type === "autonomous_agent" ? "Agent" : "Assistant";
  process.stderr.write("\n\u2705 Onboard complete!\n\n");
  process.stderr.write(`  ${typeLabel}:${" ".repeat(Math.max(1, 10 - typeLabel.length))}${args.id}\n`);
  if (args.assistant) {
    process.stderr.write(`  Assistant: ${args.assistant}\n`);
  }
  if (runtimeAgent) {
    process.stderr.write(`  Config:    ${DEFAULT_HOME_DIR}/config/agents/${runtimeAgent}/agent.yaml\n`);
  }
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

  if (runtimeAgent) {
    process.stderr.write("\n  Start the agent:\n");
    process.stderr.write("    first-tree-hub client start\n");
  }
  process.stderr.write("\n");
}
