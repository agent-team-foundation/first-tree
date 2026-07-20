import { createManagedAgentSchema } from "@first-tree/shared";
import type { Command } from "commander";
import { fail } from "../../cli/output.js";
import { isRunningInsideAgent } from "../../core/agent-context.js";
import { ensureFreshAccessToken, resolveServerUrl, saveAgentConfig } from "../../core/bootstrap.js";
import { channelConfig } from "../../core/channel.js";
import { cliFetch } from "../../core/cli-fetch.js";
import { print } from "../../core/output.js";
import { createSdk } from "../_shared/local-agent.js";
import { getCurrent, patchConfig } from "./config/_shared/fetchers.js";

type CreateOptions = {
  type: string;
  clientId?: string;
  runtime: string;
  model?: string;
  displayName?: string;
  agent?: string;
  org?: string;
  server?: string;
};

export function registerAgentCreateCommand(agent: Command): void {
  agent
    .command("create <name>")
    .description("Create an agent in First Tree and bind it locally")
    // `agent` is the near-universal intent when a human types `agent create`;
    // `human` agents come through the member lifecycle. Defaulting removes the
    // required-flag footgun from issue #1885's UX notes.
    .option("--type <type>", "Agent type: 'agent' (default) or 'human'", "agent")
    .option(
      "--client-id <id>",
      `(required from a human terminal) Client machine that will run this agent — must be owned by you. Optional inside an agent session (claimed on first bind). Run \`${channelConfig.binName} login <code>\` on that machine first.`,
    )
    .option(
      "--runtime <runtime>",
      "Runtime handler — one of: claude-code, claude-code-tui, codex, cursor, kimi-code (default: claude-code)",
      "claude-code",
    )
    .option("--model <model>", "Initial model (alias opus/sonnet/haiku or a full id); applied right after create")
    .option("--display-name <name>", "Display name")
    .option("--agent <name>", "Acting agent name (agent session only; defaults to the running agent)")
    .option("--org <id>", "Target organization id (required when you belong to multiple orgs)")
    .option("--server <url>", "First Tree server URL")
    .action(async (name: string, options: CreateOptions) => {
      try {
        // Inside an agent session, route through the gated, capability-checked
        // agent API (issue #1885). From a human terminal, keep the operator path.
        if (isRunningInsideAgent()) {
          await createAsAgent(name, options);
        } else {
          await createAsOperator(name, options);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        fail("CREATE_ERROR", msg);
      }
    });
}

/**
 * Agent-context path — provision a teammate through
 * `POST /api/v1/agent/managed-agents`. The SDK attaches `X-Agent-Id` + the
 * runtime-session token so the server attributes the call to this agent and
 * enforces the `provision-agents` capability + own-org/own-manager/own-client
 * scope. Binding/starting the teammate is left to a human/daemon.
 */
async function createAsAgent(name: string, options: CreateOptions): Promise<void> {
  if (options.type !== "agent") {
    fail(
      "INVALID_TYPE",
      "Only 'agent' teammates can be provisioned from inside an agent session; human agents are created through the member lifecycle by an operator.",
      1,
    );
  }
  if (options.model) {
    // Setting model/prompt on an agent-provisioned teammate is the config-as-agent
    // follow-up; v1's agent path is create-only. Don't silently drop the flag.
    print.line(
      "  ⚠ --model is not applied to agent-provisioned teammates yet; an admin can set it via `agent config set-model`.\n",
    );
  }

  // Parse client-side too: gives early validation + the correctly typed body.
  const body = createManagedAgentSchema.parse({
    name,
    displayName: options.displayName,
    clientId: options.clientId,
    runtimeProvider: options.runtime,
  });

  const sdk = createSdk(options.agent);
  const created = await sdk.createManagedAgent(body);

  print.line(`  ✓ Teammate agent created: ${created.name ?? created.uuid}\n`);
  print.line("  ℹ Provisioned via the gated agent path (source: agent-api).\n");
  print.line(
    `  ℹ A human/daemon must start it${options.clientId ? ` on client ${options.clientId}` : ""} — e.g. run ` +
      `\`${channelConfig.binName} agent add ${name}\` on that machine, then start the daemon.\n`,
  );
}

/**
 * Human-operator path — the original behaviour: create via the org admin route
 * with the operator's user JWT, save local config so the daemon can bind, and
 * (new) optionally set the initial model.
 */
async function createAsOperator(name: string, options: CreateOptions): Promise<void> {
  const serverUrl = resolveServerUrl(options.server);
  const adminToken = await ensureFreshAccessToken();
  if (!options.clientId) {
    fail(
      "MISSING_CLIENT_ID",
      `--client-id is required. Run \`${channelConfig.binName} login <code>\` on the target machine, then pass its client id.`,
      1,
    );
    return;
  }
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
    return;
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
  print.line(`  ✓ Agent created: ${created.name ?? created.uuid}\n`);

  const agentDir = saveAgentConfig(name, created.uuid, options.runtime);
  print.line(`  ✓ Config saved: ${agentDir}/agent.yaml\n`);

  if (options.model) {
    const current = await getCurrent(serverUrl, adminToken, created.uuid);
    await patchConfig(serverUrl, adminToken, created.uuid, current.version, { model: options.model });
    print.line(`  ✓ Model set: ${options.model}\n`);
  }

  print.line("  ✓ Agent ready — start the daemon on that machine to bind\n");
}
