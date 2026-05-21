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
} from "../../core/index.js";
import { print } from "../../core/output.js";

/**
 * `daemon doctor` — environment readiness for the local daemon: node version,
 * client.yaml, server reachability, WS, agent configs, and the background
 * service slot. The top-level `doctor` command bundles this with cross-
 * subsystem checks (tree / git / claude-code binary) once Phase 3 wires them in.
 */
export function registerDaemonDoctorCommand(daemon: Command): void {
  daemon
    .command("doctor")
    .description("Check daemon environment readiness (node, config, server, WS, agents, service)")
    .action(async () => {
      print.line("\n  First Tree Hub Daemon Doctor\n\n");
      // The "Agents" line cross-references local aliases against the
      // server's pinned-agent set, filtered to THIS client.id (so the
      // verdict matches what R-RUN will accept). Without a configured
      // server URL we can't talk to anything; fall back to the legacy
      // local-only count.
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
        // Doctor is read-only; release the singleton so subsequent
        // commands re-resolve config cleanly.
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
