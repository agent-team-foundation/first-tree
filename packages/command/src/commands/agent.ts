import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  agentConfigSchema,
  clientConfigSchema,
  DEFAULT_CONFIG_DIR,
  DEFAULT_DATA_DIR,
  loadAgents,
  resolveConfigReadonly,
  setConfigValue,
} from "@agent-team-foundation/first-tree-hub-shared/config";
import { cleanWorkspaces, FirstTreeHubSDK, SdkError, SessionRegistry } from "@first-tree-hub/client";
import { confirm } from "@inquirer/prompts";
import type { Command } from "commander";
import { fail, success } from "../cli/output.js";
import { resolveSenderName } from "../core/agent-messaging.js";
import { ensureFreshAccessToken, resolveServerUrl, saveAgentConfig } from "../core/bootstrap.js";
import { cliFetch } from "../core/cli-fetch.js";
import { bindFeishuBot, bindFeishuUser } from "../core/feishu.js";
import { findStaleAliases, formatStaleReason, promptAddAgent, removeLocalAgent } from "../core/index.js";
import { print } from "../core/output.js";
import { CLI_USER_AGENT } from "../core/version.js";
import { registerAgentConfigCommands } from "./agent-config.js";

const DEFAULT_WORKSPACE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

type ResolvedAgentConfig = {
  serverUrl: string;
  agentId: string;
};

/**
 * Resolve the agent this CLI invocation should act on. We read the local
 * `agents/<name>/agent.yaml` file to find the agentId, then pair it with the
 * user's current member JWT (refreshed on demand) at call time.
 *
 * Only one agent is expected per command invocation — if the user has many
 * agents configured they must pick one with `--agent <name>` (next step of
 * CLI polish) or rely on a single entry.
 */
function resolveLocalAgent(agentName?: string): ResolvedAgentConfig {
  const agentsDir = join(DEFAULT_CONFIG_DIR, "agents");
  const agents = loadAgents({ schema: agentConfigSchema, agentsDir });

  const resolution = resolveSenderName({
    override: agentName,
    envAgentId: process.env.FIRST_TREE_HUB_AGENT_ID,
    agents,
  });

  let resolvedName: string;
  if (resolution.kind === "ok") {
    resolvedName = resolution.name;
  } else if (resolution.kind === "none") {
    fail("MISSING_AGENT", "No agent configured. Run `first-tree-hub agent add` first.", 2);
  } else if (resolution.kind === "envMismatch") {
    fail(
      "ENV_AGENT_NOT_LOCAL",
      `FIRST_TREE_HUB_AGENT_ID="${resolution.envAgentId}" is not configured on this machine. ` +
        `Available local agents: ${resolution.available.join(", ")}. ` +
        `Pick one explicitly with \`--agent <senderName>\`.`,
      2,
    );
  } else {
    fail(
      "AMBIGUOUS_AGENT",
      `Multiple agents are configured on this machine (${resolution.available.join(", ")}) and ` +
        `FIRST_TREE_HUB_AGENT_ID is not set, so the CLI can't tell which one is the sender. ` +
        `Specify it explicitly with \`--agent <senderName>\`.`,
      2,
    );
  }
  const cfg = agents.get(resolvedName);
  if (!cfg) {
    fail("UNKNOWN_AGENT", `Agent "${resolvedName}" not found in ${agentsDir}`, 2);
  }

  let serverUrl: string;
  try {
    serverUrl = resolveServerUrl(process.env.FIRST_TREE_HUB_SERVER_URL);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    fail("MISSING_SERVER_URL", msg, 2);
  }

  return { serverUrl, agentId: cfg.agentId };
}

function createSdk(agentName?: string): FirstTreeHubSDK {
  const { serverUrl, agentId } = resolveLocalAgent(agentName);
  return new FirstTreeHubSDK({
    serverUrl,
    getAccessToken: (opts) => ensureFreshAccessToken(opts),
    agentId,
    userAgent: CLI_USER_AGENT,
  });
}

function handleSdkError(error: unknown): never {
  if (error instanceof SdkError) {
    const exitCode = error.statusCode === 401 ? 3 : 1;
    fail(`HTTP_${error.statusCode}`, error.message, exitCode);
  }
  if (error instanceof TypeError && "cause" in error) {
    fail("CONNECTION_ERROR", `Cannot connect to server: ${error.message}`, 6);
  }
  const msg = error instanceof Error ? error.message : String(error);
  fail("UNKNOWN_ERROR", msg, 1);
}

type ResolvedAgent = { uuid: string; name: string | null; displayName: string | null };

async function resolveAgent(serverUrl: string, adminToken: string, agentName: string): Promise<ResolvedAgent> {
  // /me/managed-agents — cross-org list of every agent the caller manages.
  // Avoids needing a per-org `--org` flag on every command that operates on
  // an agent by name.
  const res = await cliFetch(`${serverUrl}/api/v1/me/managed-agents`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    fail("FETCH_ERROR", `Failed to list agents: ${res.status}`, 1);
  }
  const items = (await res.json()) as ResolvedAgent[];
  const found = items.find((a) => a.name === agentName || a.uuid === agentName);
  if (!found) {
    fail("NOT_FOUND", `Agent "${agentName}" not found`, 1);
  }
  return found;
}

/**
 * Read the persisted `client.id` from `client.yaml`. Required by `agent
 * prune` to filter the user-scoped `listMyAgents` response down to "what
 * actually binds on THIS machine". `fail()` instead of throwing so the
 * "no client.yaml — run connect <token> first" path renders as a clean
 * CLI error rather than a stack trace.
 */
function readClientId(): string {
  const cfg = resolveConfigReadonly({ schema: clientConfigSchema, role: "client" }) as {
    client?: { id?: unknown };
  };
  const id = cfg.client?.id;
  if (typeof id !== "string" || id.length === 0) {
    fail("MISSING_CLIENT_ID", "No client.id found in client.yaml. Run `first-tree-hub connect <token>` first.", 2);
  }
  return id;
}

// ── Main registration ─────────────────────────────────────────────────

export function registerAgentCommands(program: Command): void {
  const agent = program.command("agent").description("Agent management — config, bindings, messaging");

  registerAgentConfigCommands(agent);

  // ── Config management (add / remove / list) ─────────────────────────

  agent
    .command("add")
    .description("Register an existing Hub agent on this client (uses the agent name from the Hub)")
    .option("--agent-id <id>", "Agent UUID on the Hub")
    .action(async (options?: { agentId?: string }) => {
      try {
        // Phase 3 of the agent-naming refactor retired the free-form
        // local alias — the local config dir is always keyed by the
        // server-side `agent.name`. The prompt helper fetches that name
        // from the Hub given the agent UUID.
        const { name: agentName, agentId } = await promptAddAgent({ agentId: options?.agentId });
        if (!agentName || !agentId) {
          fail("MISSING_AGENT_ARGS", "Agent UUID (and a hub name for that UUID) are required.", 2);
        }

        const agentDir = join(DEFAULT_CONFIG_DIR, "agents", agentName);
        mkdirSync(agentDir, { recursive: true, mode: 0o700 });
        setConfigValue(join(agentDir, "agent.yaml"), "agentId", agentId);

        print.line(`  Agent "${agentName}" added.\n`);
        print.line(`  Config: ${join(agentDir, "agent.yaml")}\n`);
      } catch (error) {
        if ((error as { name?: string }).name === "ExitPromptError") {
          print.line("\n  Cancelled.\n");
          return;
        }
        const msg = error instanceof Error ? error.message : String(error);
        print.line(`  Error: ${msg}\n`);
        process.exit(1);
      }
    });

  agent
    .command("remove <name>")
    .description(
      "Remove an agent from this client and delete its local runtime data (config dir, workspace, session state)",
    )
    .action((name: string) => {
      const agentDir = join(DEFAULT_CONFIG_DIR, "agents", name);
      if (!existsSync(agentDir)) {
        print.line(`  Agent "${name}" not found.\n`);
        process.exit(1);
      }
      removeLocalAgent(name);

      print.line(`  Agent "${name}" removed.\n`);
    });

  // ── prune — drop local aliases the server no longer pins to me ─────
  // Counterpart to `client doctor`'s "stale aliases" warning. Walks the
  // local `agents/<name>/` dirs and removes any whose `agentId` is not
  // returned by `/api/v1/me/pinned-agents`. Common after `client claim`,
  // after the previous owner deleted an agent server-side, or after a
  // typo `agent add` left a junk dir.
  agent
    .command("prune")
    .description("Remove local agent aliases that won't bind on this client (unowned, pinned elsewhere, or unreadable)")
    .option("--yes", "Skip the interactive confirmation prompt")
    .option("--dry-run", "Only list what would be removed; don't touch the filesystem")
    .option("--server <url>", "Hub server URL")
    .action(async (options: { yes?: boolean; dryRun?: boolean; server?: string }) => {
      try {
        const serverUrl = resolveServerUrl(options.server);
        const clientId = readClientId();
        const sdk = new FirstTreeHubSDK({
          serverUrl,
          getAccessToken: (opts) => ensureFreshAccessToken(opts),
          userAgent: CLI_USER_AGENT,
        });
        const stale = await findStaleAliases({
          clientId,
          listPinnedAgents: () => sdk.listMyAgents(),
        });

        if (stale.length === 0) {
          print.line("\n  ✓ No stale agent aliases. Local config matches the server.\n\n");
          return;
        }

        print.line(`\n  ${stale.length} stale ${stale.length === 1 ? "alias" : "aliases"}:\n\n`);
        for (const s of stale) {
          const id = s.agentId ?? "—";
          print.line(`    - ${s.name.padEnd(30)} ${id.padEnd(38)} ${formatStaleReason(s.reason)}\n`);
        }
        print.line("\n");

        if (options.dryRun) {
          print.line("  Dry run — no files removed. Re-run without --dry-run to delete.\n\n");
          return;
        }

        if (!options.yes) {
          const approved = await confirm({
            message: `Remove the ${stale.length} stale ${stale.length === 1 ? "alias" : "aliases"} above (config + workspace + session state)?`,
            default: false,
          }).catch(() => false);
          if (!approved) {
            print.line("  Cancelled.\n\n");
            return;
          }
        }

        // Per-alias try/catch so a single permission/lock error doesn't
        // skip the rest of the cleanup. Failures are reported inline; the
        // user can re-run prune to retry the failed entries.
        let removed = 0;
        let failed = 0;
        for (const s of stale) {
          try {
            removeLocalAgent(s.name);
            print.line(`  ✓ removed ${s.name}\n`);
            removed++;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            print.line(`  ✗ ${s.name} (${msg.slice(0, 80)})\n`);
            failed++;
          }
        }
        print.line(`\n  ${removed} pruned${failed > 0 ? `, ${failed} failed (re-run to retry)` : ""}.\n\n`);
        if (failed > 0) process.exitCode = 1;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        fail("PRUNE_ERROR", msg);
      }
    });

  agent
    .command("list")
    .description("List agents — locally-configured by default, or every agent you manage with --remote")
    // --remote / --org pull from `GET /me/managed-agents` (cross-org by
    // design — decouple-client-from-identity §4.5.1 case (b)). --org filters
    // the same response client-side; the server endpoint is unfiltered so
    // the cache works across views without an extra round-trip.
    .option("--remote", "List every agent you manage on the Hub server (cross-org)")
    .option("--org <id>", "When listing remote, restrict to a single organization id")
    .option("--server <url>", "Hub server URL")
    .action(async (options: { remote?: boolean; org?: string; server?: string }) => {
      const wantRemote = options.remote === true || typeof options.org === "string";
      if (!wantRemote) {
        const agentsDir = join(DEFAULT_CONFIG_DIR, "agents");
        try {
          const agents = loadAgents({ schema: agentConfigSchema, agentsDir });
          if (agents.size === 0) {
            print.line("  No agents configured.\n");
            return;
          }
          for (const [name, config] of agents) {
            // Label the UUID column as `uuid` — NOT `agentId` — to discourage
            // agents from copy-pasting the uuid into `chat send <target>`,
            // which expects the agent name. See the Agent Hub SDK section of
            // the bootstrap-generated CLAUDE.md.
            print.line(`  ${name.padEnd(20)} runtime: ${config.runtime.padEnd(14)} uuid: ${config.agentId}\n`);
          }
        } catch {
          print.line("  No agents configured.\n");
        }
        return;
      }

      try {
        const serverUrl = resolveServerUrl(options.server);
        const token = await ensureFreshAccessToken();
        const res = await cliFetch(`${serverUrl}/api/v1/me/managed-agents`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
          fail("LIST_ERROR", `Server returned ${res.status}`, 1);
        }
        const agents = (await res.json()) as Array<{
          uuid: string;
          name: string | null;
          displayName: string;
          type: string;
          organizationId: string;
          runtimeProvider: string;
          clientId: string | null;
        }>;
        const filtered = options.org ? agents.filter((a) => a.organizationId === options.org) : agents;
        if (filtered.length === 0) {
          print.line("  No agents found.\n");
          return;
        }
        const header = `  ${"NAME".padEnd(24)} ${"TYPE".padEnd(20)} ${"RUNTIME".padEnd(14)} ${"ORG".padEnd(40)} CLIENT`;
        print.line(`${header}\n`);
        print.line(`  ${"─".repeat(header.length - 2)}\n`);
        for (const a of filtered) {
          print.line(
            `  ${(a.name ?? a.uuid).padEnd(24)} ${a.type.padEnd(20)} ${a.runtimeProvider.padEnd(14)} ${a.organizationId.padEnd(40)} ${a.clientId ?? "—"}\n`,
          );
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        fail("LIST_ERROR", msg);
      }
    });

  // ── CLI-first agent creation ────────────────────────────────────────

  agent
    .command("create <name>")
    .description("Create an agent on Hub and bind it locally")
    .requiredOption("--type <type>", "Agent type (human, personal_assistant, autonomous_agent)")
    .requiredOption(
      "--client-id <id>",
      "Client (machine) that will run this agent — must be owned by you. Run `first-tree-hub connect <token>` on that machine first.",
    )
    .option("--runtime <runtime>", "Runtime handler (default: claude-code)", "claude-code")
    .option("--display-name <name>", "Display name")
    .option("--org <id>", "Target organization id (required when you belong to multiple orgs)")
    .option("--server <url>", "Hub server URL")
    .action(
      async (
        name: string,
        options: {
          type: string;
          clientId: string;
          runtime: string;
          displayName?: string;
          org?: string;
          server?: string;
        },
      ) => {
        try {
          const serverUrl = resolveServerUrl(options.server);
          const adminToken = await ensureFreshAccessToken();
          const headers = {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          };

          // Resolve target org. Single-org users are auto-selected; multi-org
          // users must pass `--org`. JWT no longer carries default org.
          const meRes = await cliFetch(`${serverUrl}/api/v1/me`, {
            headers: { Authorization: `Bearer ${adminToken}` },
            signal: AbortSignal.timeout(10_000),
          });
          if (!meRes.ok) fail("FETCH_ERROR", `Failed to fetch /me: HTTP ${meRes.status}`, 1);
          const me = (await meRes.json()) as {
            memberships: Array<{ organizationId: string; organizationName: string; role: string }>;
            defaultOrganizationId?: string | null;
          };
          let orgId: string;
          if (options.org) {
            if (!me.memberships.some((m) => m.organizationId === options.org)) {
              fail("ORG_NOT_FOUND", `Not an active member of organization "${options.org}"`, 1);
            }
            orgId = options.org;
          } else if (me.memberships.length === 1) {
            orgId = me.memberships[0]?.organizationId ?? "";
          } else if (me.memberships.length === 0) {
            fail("NO_ORG", "You don't belong to any organization", 1);
          } else {
            const list = me.memberships.map((m) => `  ${m.organizationId}  (${m.organizationName})`).join("\n");
            fail("AMBIGUOUS_ORG", `You belong to multiple organizations — pass --org <id>:\n${list}`, 1);
            return;
          }

          const createBody: Record<string, unknown> = {
            name,
            type: options.type,
            clientId: options.clientId,
            runtimeProvider: options.runtime,
          };
          if (options.displayName) createBody.displayName = options.displayName;

          const createRes = await cliFetch(`${serverUrl}/api/v1/orgs/${encodeURIComponent(orgId)}/agents`, {
            method: "POST",
            headers,
            body: JSON.stringify(createBody),
            signal: AbortSignal.timeout(10_000),
          });
          if (!createRes.ok) {
            const body = (await createRes.json().catch(() => ({}))) as { error?: string };
            fail("CREATE_ERROR", body.error ?? `Failed to create agent (HTTP ${createRes.status})`, 1);
          }
          const created = (await createRes.json()) as { uuid: string; name: string | null };
          print.line(`  \u2713 Agent created: ${created.name ?? created.uuid}\n`);

          const agentDir = saveAgentConfig(name, created.uuid, options.runtime);
          print.line(`  \u2713 Config saved: ${agentDir}/agent.yaml\n`);
          print.line("  \u2713 Agent ready — start the client on that machine to bind\n");
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          fail("CREATE_ERROR", msg);
        }
      },
    );

  // ── Claim (set manager) ─────────────────────────────────────────────

  agent
    .command("claim <agentName>")
    .description("Become the manager of an agent (admin-only, or self-claim an unmanaged agent)")
    .option("--server <url>", "Hub server URL")
    .action(async (agentName: string, options: { server?: string }) => {
      try {
        const serverUrl = resolveServerUrl(options.server);
        const accessToken = await ensureFreshAccessToken();

        // Look up the authenticated member's id via /me
        const meRes = await cliFetch(`${serverUrl}/api/v1/me`, {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!meRes.ok) fail("ME_ERROR", `Failed to fetch current member (HTTP ${meRes.status})`, 1);
        const me = (await meRes.json()) as { memberId: string };

        const target = await resolveAgent(serverUrl, accessToken, agentName);

        const patchRes = await cliFetch(`${serverUrl}/api/v1/agents/${target.uuid}`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ managerId: me.memberId }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!patchRes.ok) {
          const body = (await patchRes.json().catch(() => ({}))) as { error?: string };
          fail("CLAIM_ERROR", body.error ?? `Claim failed (HTTP ${patchRes.status})`, 1);
        }
        print.line(`  Claimed "${target.name ?? target.uuid}" — now managed by you.\n`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        fail("CLAIM_ERROR", msg);
      }
    });

  // ── Workspace management ────────────────────────────────────────────

  const workspace = agent.command("workspace").description("Manage agent workspaces");

  workspace
    .command("clean [agent-name]")
    .description("Remove stale workspace directories (older than TTL with no active session)")
    .option("--ttl <days>", "TTL in days", String(DEFAULT_WORKSPACE_TTL_MS / (24 * 60 * 60 * 1000)))
    .action((agentName?: string, options?: { ttl: string }) => {
      const defaultDays = DEFAULT_WORKSPACE_TTL_MS / (24 * 60 * 60 * 1000);
      const ttlMs = Number.parseInt(options?.ttl ?? String(defaultDays), 10) * 24 * 60 * 60 * 1000;
      const workspacesDir = join(DEFAULT_DATA_DIR, "workspaces");

      if (!existsSync(workspacesDir)) {
        print.line("  No workspaces found.\n");
        return;
      }

      const agentNames = agentName ? [agentName] : readdirSync(workspacesDir);
      let totalRemoved = 0;

      for (const name of agentNames) {
        const agentWorkspaceRoot = join(workspacesDir, name);
        if (!existsSync(agentWorkspaceRoot)) continue;

        const registryPath = join(DEFAULT_DATA_DIR, "sessions", `${name}.json`);
        const registry = new SessionRegistry(registryPath);
        const persisted = registry.load();
        const activeChatIds = new Set<string>();
        for (const [chatId, data] of persisted) {
          if (data.status !== "evicted") {
            activeChatIds.add(chatId);
          }
        }

        const removed = cleanWorkspaces(agentWorkspaceRoot, activeChatIds, ttlMs);
        totalRemoved += removed.length;
        for (const chatId of removed) {
          print.line(`  Removed: ${name}/${chatId}\n`);
        }
      }

      print.line(`  ${totalRemoved} workspace(s) cleaned.\n`);
    });

  // ── Bind (client machine / Feishu bot / user) ───────────────────────

  const bind = agent.command("bind").description("Bind an agent to a client machine or external IM account");

  bind
    .command("client <agentName>")
    .description("Bind an unbound agent to a client machine (first-time bind only — ID is immutable once set)")
    .requiredOption(
      "--client-id <id>",
      "Client (machine) ID — must be owned by you. Run `first-tree-hub connect <token>` on that machine first.",
    )
    .option("--server <url>", "Hub server URL")
    .action(async (agentName: string, options: { clientId: string; server?: string }) => {
      try {
        const serverUrl = resolveServerUrl(options.server);
        const accessToken = await ensureFreshAccessToken();
        const target = await resolveAgent(serverUrl, accessToken, agentName);

        const patchRes = await cliFetch(`${serverUrl}/api/v1/agents/${target.uuid}`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ clientId: options.clientId }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!patchRes.ok) {
          const body = (await patchRes.json().catch(() => ({}))) as { error?: string };
          fail("BIND_CLIENT_ERROR", body.error ?? `Bind failed (HTTP ${patchRes.status})`, 1);
        }
        print.line(`  \u2713 Bound "${target.name ?? target.uuid}" to client ${options.clientId}.\n`);
        success({ agentId: target.uuid, clientId: options.clientId });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        fail("BIND_CLIENT_ERROR", msg);
      }
    });

  bind
    .command("bot")
    .description("Bind a Feishu bot to this agent (self-service)")
    .requiredOption("--platform <platform>", "Platform: feishu")
    .requiredOption("--app-id <id>", "Feishu bot App ID")
    .requiredOption("--app-secret <secret>", "Feishu bot App Secret")
    .option("--agent <name>", "Agent name on the Hub (default: first configured on this client)")
    .option("--server <url>", "Hub server URL")
    .action(
      async (options: { platform: string; appId: string; appSecret: string; agent?: string; server?: string }) => {
        try {
          if (options.platform !== "feishu") {
            fail("UNSUPPORTED_PLATFORM", `Platform "${options.platform}" is not supported. Use "feishu".`);
          }

          const serverUrl = resolveServerUrl(options.server);
          const { agentId } = resolveLocalAgent(options.agent);
          const accessToken = await ensureFreshAccessToken();
          await bindFeishuBot(serverUrl, accessToken, agentId, options.appId, options.appSecret);
          print.line("Feishu bot bound successfully.\n");
          success({ platform: "feishu", bound: true });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          fail("BIND_BOT_ERROR", msg);
        }
      },
    );

  bind
    .command("user <humanAgentId>")
    .description("Bind a Feishu user to a human agent (via delegate_mention)")
    .requiredOption("--platform <platform>", "Platform: feishu")
    .requiredOption("--feishu-id <id>", "Feishu user ID (ou_xxx)")
    .option("--agent <name>", "Agent name on the Hub (default: first configured on this client)")
    .option("--server <url>", "Hub server URL")
    .action(
      async (
        humanAgentId: string,
        options: { platform: string; feishuId: string; agent?: string; server?: string },
      ) => {
        try {
          if (options.platform !== "feishu") {
            fail("UNSUPPORTED_PLATFORM", `Platform "${options.platform}" is not supported. Use "feishu".`);
          }

          const serverUrl = resolveServerUrl(options.server);
          const { agentId } = resolveLocalAgent(options.agent);
          const accessToken = await ensureFreshAccessToken();
          await bindFeishuUser(serverUrl, accessToken, agentId, humanAgentId, options.feishuId);
          print.line(`Feishu user ${options.feishuId} bound to ${humanAgentId}.\n`);
          success({ platform: "feishu", humanAgentId, feishuUserId: options.feishuId });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          fail("BIND_USER_ERROR", msg);
        }
      },
    );

  // ── Runtime status & management ─────────────────────────────────────

  agent
    .command("status [name]")
    .description("Show agent runtime status from Hub server")
    .option("--server <url>", "Hub server URL")
    .action(async (name?: string, options?: { server?: string }) => {
      try {
        const serverUrl = resolveServerUrl(options?.server);
        const accessToken = await ensureFreshAccessToken();
        // Activity is org-scoped — gather across every org the caller belongs
        // to so a multi-org user's `status` aggregates all runtimes.
        const meRes = await cliFetch(`${serverUrl}/api/v1/me`, {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!meRes.ok) fail("FETCH_ERROR", `/me HTTP ${meRes.status}`, 1);
        const me = (await meRes.json()) as { memberships: Array<{ organizationId: string }> };
        type ActivityResponse = {
          total: number;
          running: number;
          byState: { idle: number; working: number; blocked: number; error: number };
          clients: number;
          agents: Array<{
            agentId: string;
            clientId: string | null;
            runtimeType: string | null;
            runtimeState: string | null;
            activeSessions: number | null;
            totalSessions: number | null;
          }>;
        };
        const data: ActivityResponse = {
          total: 0,
          running: 0,
          byState: { idle: 0, working: 0, blocked: 0, error: 0 },
          clients: 0,
          agents: [],
        };
        for (const m of me.memberships) {
          const r = await cliFetch(`${serverUrl}/api/v1/orgs/${encodeURIComponent(m.organizationId)}/activity`, {
            headers: { Authorization: `Bearer ${accessToken}` },
            signal: AbortSignal.timeout(10_000),
          });
          if (!r.ok) continue;
          const part = (await r.json()) as ActivityResponse;
          data.total += part.total;
          data.running += part.running;
          data.byState.idle += part.byState.idle;
          data.byState.working += part.byState.working;
          data.byState.blocked += part.byState.blocked;
          data.byState.error += part.byState.error;
          data.clients += part.clients;
          data.agents.push(...part.agents);
        }

        if (name) {
          const ag = data.agents.find((a) => a.agentId === name);
          if (!ag) {
            print.line(`\n  Agent "${name}" is not running.\n\n`);
            return;
          }
          print.line(`\n  Agent: ${ag.agentId}\n`);
          print.line(`  Runtime: ${ag.runtimeType ?? "—"}\n`);
          print.line(`  State: ${ag.runtimeState ?? "—"}\n`);
          if (ag.activeSessions !== null) {
            print.line(`  Sessions: ${ag.activeSessions} active / ${ag.totalSessions ?? 0} total\n`);
          }
          if (ag.clientId) {
            print.line(`  Client: ${ag.clientId}\n`);
          }
          print.line("\n");
          return;
        }

        print.line(`\n  Hub: ${serverUrl}\n\n`);
        print.line(`  Clients: ${data.clients} connected\n`);
        print.line(`  Agents: ${data.running} running / ${data.total} total\n`);
        print.line(
          `  Errors: ${data.byState.error} | Blocked: ${data.byState.blocked} | Working: ${data.byState.working} | Idle: ${data.byState.idle}\n\n`,
        );

        if (data.agents.length > 0) {
          const header = `  ${"AGENT".padEnd(18)} ${"RUNTIME".padEnd(14)} ${"STATE".padEnd(10)} SESSIONS`;
          print.line(`${header}\n`);
          print.line(`  ${"─".repeat(header.length - 2)}\n`);
          for (const a of data.agents) {
            const sessions = a.activeSessions !== null ? `${a.activeSessions}/${a.totalSessions ?? 0}` : "—";
            print.line(
              `  ${(a.agentId ?? "").padEnd(18)} ${(a.runtimeType ?? "—").padEnd(14)} ${(a.runtimeState ?? "—").padEnd(10)} ${sessions}\n`,
            );
          }
          print.line("\n");
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        fail("STATUS_ERROR", msg);
      }
    });

  agent
    .command("reset <name>")
    .description("Reset agent error state to idle")
    .option("--server <url>", "Hub server URL")
    .action(async (name: string, options: { server?: string }) => {
      try {
        const serverUrl = resolveServerUrl(options.server);
        const response = await cliFetch(`${serverUrl}/api/v1/agents/${name}/reset-activity`, {
          method: "POST",
          headers: { Authorization: `Bearer ${await ensureFreshAccessToken()}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          fail("RESET_ERROR", `Server returned ${response.status}`, 1);
        }
        print.line(`  Agent "${name}" reset to idle.\n`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        fail("RESET_ERROR", msg);
      }
    });

  // ── Session management ──────────────────────────────────────────────

  const sessionCmd = agent.command("session").description("Session lifecycle commands");

  sessionCmd
    .command("list <agent-name>")
    .description("List sessions for an agent")
    .option("--server <url>", "Hub server URL")
    .option("--state <state>", "Filter by session state (active/suspended/evicted)")
    .action(async (agentName: string, options: { server?: string; state?: string }) => {
      try {
        const serverUrl = resolveServerUrl(options.server);
        const adminToken = await ensureFreshAccessToken();
        const agentId = (await resolveAgent(serverUrl, adminToken, agentName)).uuid;
        const qs = options.state ? `?state=${options.state}` : "";
        const response = await cliFetch(`${serverUrl}/api/v1/agents/${agentId}/sessions${qs}`, {
          headers: { Authorization: `Bearer ${adminToken}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          fail("FETCH_ERROR", `Server returned ${response.status}`, 1);
        }
        const sessions = (await response.json()) as Array<{
          chatId: string;
          state: string;
          runtimeState: string | null;
          lastActivityAt: string;
        }>;
        if (sessions.length === 0) {
          print.line(`\n  No sessions for "${agentName}".\n\n`);
          return;
        }
        print.line(`\n  Sessions for "${agentName}":\n\n`);
        const header = `  ${"CHAT".padEnd(40)} ${"STATE".padEnd(12)} ${"RUNTIME".padEnd(10)} LAST ACTIVITY`;
        print.line(`${header}\n`);
        print.line(`  ${"─".repeat(header.length - 2)}\n`);
        for (const s of sessions) {
          const chatShort = s.chatId.length > 38 ? `${s.chatId.slice(0, 35)}...` : s.chatId;
          print.line(
            `  ${chatShort.padEnd(40)} ${s.state.padEnd(12)} ${(s.runtimeState ?? "—").padEnd(10)} ${s.lastActivityAt}\n`,
          );
        }
        print.line("\n");
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        fail("SESSIONS_ERROR", msg);
      }
    });

  for (const [cmd, desc] of [
    ["suspend", "Suspend a session"],
    ["terminate", "Terminate a session"],
  ] as const) {
    sessionCmd
      .command(`${cmd} <agent-name> <chat-id>`)
      .description(desc)
      .option("--server <url>", "Hub server URL")
      .action(async (agentName: string, chatId: string, options: { server?: string }) => {
        try {
          const serverUrl = resolveServerUrl(options.server);
          const adminToken = await ensureFreshAccessToken();
          const agentId = (await resolveAgent(serverUrl, adminToken, agentName)).uuid;
          const response = await cliFetch(`${serverUrl}/api/v1/agents/${agentId}/sessions/${chatId}/${cmd}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${adminToken}` },
            signal: AbortSignal.timeout(10_000),
          });
          if (!response.ok) {
            const body = await response.text();
            fail("SESSION_CMD_ERROR", `Server returned ${response.status}: ${body}`, 1);
          }
          print.line(`  Session ${cmd}: ${chatId} → sent\n`);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          fail("SESSION_CMD_ERROR", msg);
        }
      });
  }

  // ── Low-level SDK debugging (hidden from `agent --help`) ────────────

  const debugCmd = agent.command("debug", { hidden: true }).description("Low-level SDK debug commands");

  debugCmd
    .command("register")
    .description("Register this agent and return identity info")
    .option("--agent <name>", "Agent name on the Hub (default: first configured on this client)")
    .action(async (options: { agent?: string }) => {
      try {
        const sdk = createSdk(options.agent);
        const result = await sdk.register();
        success(result);
      } catch (error) {
        handleSdkError(error);
      }
    });
}
