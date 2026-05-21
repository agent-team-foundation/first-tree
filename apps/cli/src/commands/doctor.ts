import { FirstTreeHubSDK } from "@first-tree/client";
import { clientConfigSchema, initConfig, resetConfig, resetConfigMeta } from "@first-tree/shared/config";
import type { Command } from "commander";
import {
  CLI_USER_AGENT,
  checkAgentConfigs,
  checkBackgroundService,
  checkClientConfig,
  checkNodeVersion,
  checkServerReachable,
  checkWebSocket,
  ensureFreshAccessToken,
  printResults,
  reconcileAgentConfigs,
  resolveServerUrl,
} from "../core/index.js";
import { print } from "../core/output.js";

/**
 * Top-level `first-tree-hub doctor` — environment readiness across every
 * subsystem the Hub touches. Phase 1A ships only the daemon-side checks
 * (mirrors `daemon doctor`); Phase 3 will plug in tree / git / claude-code
 * binary checks once those subsystems are wired through.
 */
export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Cross-subsystem readiness check (daemon, server, WS, agents)")
    .action(async () => {
      print.line("\n  First Tree Hub Doctor\n\n");
      let agentCheck: Awaited<ReturnType<typeof reconcileAgentConfigs>>;
      try {
        const serverUrl = resolveServerUrl();
        const cfg = await initConfig({ schema: clientConfigSchema, role: "client" });
        const sdk = new FirstTreeHubSDK({
          serverUrl,
          getAccessToken: (opts) => ensureFreshAccessToken(opts),
          userAgent: CLI_USER_AGENT,
        });
        agentCheck = await reconcileAgentConfigs({
          clientId: cfg.client.id,
          listPinnedAgents: () => sdk.listMyAgents(),
        });
      } catch {
        agentCheck = checkAgentConfigs();
      } finally {
        resetConfig();
        resetConfigMeta();
      }
      const results = [
        checkNodeVersion(),
        checkClientConfig(),
        await checkServerReachable(),
        agentCheck,
        await checkWebSocket(),
        checkBackgroundService(),
      ];
      printResults(results);
    });
}
