#!/usr/bin/env node
// One-shot local bring-up for hand-driving the `claude-code-tui` runtime
// against the e2e world.
//
// What it does:
//   1. Boots pg + server + daemon with the fake-tui binary on
//      CLAUDE_CODE_EXECUTABLE (same wiring the TUI tests use).
//   2. Creates one TUI-runtime agent and a chat with it.
//   3. Prints how to send a user message + where to tail the daemon log +
//      where the fake-tui side-channel log lives.
//   4. Keeps the world up until Ctrl-C; teardown runs through the lifecycle
//      pre-teardown hooks (so pg containers + tmux sessions are cleaned).
//
// Usage:
//   node packages/e2e/scripts/dev-bootstrap.mjs
//
// Why a script vs another vitest config: scenarios run + tear down in
// seconds. This is for when a human wants to poke at a running TUI agent
// via `tmux attach -t ftth-...`, `tail -f ...`, and `curl POST .../messages`
// to validate something the auto-tests don't cover.
//
// Pure orchestration — re-uses every helper from `src/framework/`. No
// product-code paths reimplemented here.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const PACKAGE_E2E_ROOT = resolve(import.meta.dirname, "..");
const FRAMEWORK_DIST = resolve(PACKAGE_E2E_ROOT, "src/framework");

function log(line) {
  process.stdout.write(`[dev-bootstrap] ${line}\n`);
}

function fatal(line) {
  process.stderr.write(`[dev-bootstrap] FATAL: ${line}\n`);
  process.exit(1);
}

async function main() {
  // Sanity: tmux + node availability. Anything else is the lifecycle's job.
  const tmuxRes = spawnSync("tmux", ["-V"], { encoding: "utf-8" });
  if (tmuxRes.status !== 0) fatal("tmux not found — install it (`brew install tmux`) before re-running.");

  log("Building dist CLI (needed to spawn the daemon)…");
  const buildRes = spawnSync(
    "pnpm",
    ["--filter", "first-tree-dev", "--filter", "@first-tree/server", "--filter", "@first-tree/shared", "build"],
    { cwd: REPO_ROOT, stdio: "inherit" },
  );
  if (buildRes.status !== 0) fatal("dist build failed; see output above.");

  // Lazy import so the build above happens first (the framework imports
  // built packages via workspace links).
  const lifecycle = await import(`${FRAMEWORK_DIST}/lifecycle.ts`);
  const fixture = await import(`${FRAMEWORK_DIST}/runtime-tui-fixture.ts`);
  const currentHandle = await import(`${FRAMEWORK_DIST}/current-handle.ts`);

  log("Starting pg + server + daemon (fake-tui mode)…");
  const world = await lifecycle.startRunWorld({
    withClient: true,
    serverExtraEnv: { FIRST_TREE_DEV_CALLBACK_ENABLED: "1" },
    clientClaudeCodeExecutable: fixture.FAKE_CLAUDE_TUI_EXECUTABLE,
    clientExtraEnv: { ANTHROPIC_API_KEY: "fake-tui-e2e-key" },
  });

  // Mirror what global-setup.ts writes so any auxiliary scripts (e.g. doctor)
  // can read the run handle without re-deriving anything.
  mkdirSync(resolve(PACKAGE_E2E_ROOT, ".e2e-runs"), { recursive: true });
  writeFileSync(
    currentHandle.HANDLE_PATH,
    JSON.stringify(
      {
        runId: world.identity.runId,
        serverBaseUrl: world.server.baseUrl,
        databaseUrl: world.pg.databaseUrl,
        clientHome: world.identity.home,
        jwtSecret: world.jwtSecret,
        githubWebhookSecret: world.githubApp.webhookSecret,
        credentials: world.credentials,
      },
      null,
      2,
    ),
  );

  const handle = currentHandle.readCurrentHandle();
  log(`World up. runId=${handle.runId}`);
  log(`server: ${handle.serverBaseUrl}`);
  log(`pg:     ${handle.databaseUrl}`);
  log(`home:   ${handle.clientHome}`);

  log("Creating one TUI agent + chat for hand-driving…");
  const tui = await fixture.createTuiAgent({ handle, displayName: "dev-bootstrap TUI agent" });

  log("");
  log("=== Ready ===");
  log(`agent uuid:    ${tui.agentId}`);
  log(`agent name:    ${tui.agentName}`);
  log(`chat id:       ${tui.chatId}`);
  log(`fake-tui log:  ${tui.logPath}`);
  log(`tmux sessions: tmux ls   (look for ftth-<tag>-… prefix)`);
  log("");
  log("Send a user message (mention the agent so it actually wakes — the");
  log("group-chat policy rejects a send with no explicit recipient):");
  log(
    `  curl -X POST '${handle.serverBaseUrl}/api/v1/chats/${tui.chatId}/messages' \\\n` +
      `       -H 'Content-Type: application/json' \\\n` +
      `       -H 'Authorization: Bearer ${handle.credentials?.accessToken}' \\\n` +
      `       -d '${JSON.stringify({
        format: "text",
        content: "ping from dev-bootstrap",
        metadata: { mentions: [tui.agentId] },
      })}'`,
  );
  log("");
  log("Tail what the fake-tui process saw:");
  log(`  tail -f ${tui.logPath}`);
  log("");
  log("Press Ctrl-C to tear everything down.");

  const onSignal = async (sig) => {
    log(`Got ${sig}; tearing down.`);
    await lifecycle.stopRunWorld().catch((err) => process.stderr.write(`teardown error: ${err}\n`));
    process.exit(0);
  };
  process.on("SIGINT", () => void onSignal("SIGINT"));
  process.on("SIGTERM", () => void onSignal("SIGTERM"));

  // Park the event loop.
  await new Promise(() => {});
}

main().catch((err) => fatal(err instanceof Error ? (err.stack ?? err.message) : String(err)));
