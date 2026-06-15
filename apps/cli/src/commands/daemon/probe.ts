import { probeCapabilities } from "@first-tree/client";
import { clientConfigSchema, initConfig, resetConfig, resetConfigMeta } from "@first-tree/shared/config";
import type { Command } from "commander";
import { fail } from "../../cli/output.js";
import { channelConfig } from "../../core/channel.js";
import {
  ensureFreshAccessToken,
  loadCredentials,
  printResults,
  runtimeProviderChecks,
  uploadClientCapabilities,
} from "../../core/index.js";
import { print } from "../../core/output.js";

/**
 * `daemon probe` — run the launch-verified capability probes on demand and
 * upload the result. The daemon only probes at startup, so this is the way to
 * refresh a client's advertised capabilities after installing / logging into a
 * provider without restarting the daemon — and to see the real, verbatim probe
 * result locally. Each probe really launches its provider, so this is not free
 * (a 1-turn haiku query / a `codex doctor` handshake).
 */
export function registerDaemonProbeCommand(daemon: Command): void {
  daemon
    .command("probe")
    .description("Launch-probe local runtime providers and upload the result to the server")
    .option("--no-upload", "Run the probes and print results without uploading to the server")
    .option("--json", "Emit the raw capability JSON instead of a formatted report")
    .action(async (options: { upload?: boolean; json?: boolean }) => {
      const binName = channelConfig.binName;
      // Fail closed: the upload (and the JWT it needs) requires credentials.
      if (!loadCredentials()) {
        fail("NO_CREDENTIALS", `no credentials — run \`${binName} login <token>\` to sign in first.`, 1);
      }

      try {
        const config = await initConfig({ schema: clientConfigSchema, role: "client" });

        if (!options.json) {
          print.line("\n  Probing runtime providers (each provider is launched for real)...\n\n");
        }
        const capabilities = await probeCapabilities();

        if (options.json) {
          print.line(`${JSON.stringify(capabilities, null, 2)}\n`);
        } else {
          printResults(runtimeProviderChecks(capabilities));
        }

        if (options.upload === false) {
          if (!options.json) print.line("  Skipped upload (--no-upload).\n\n");
          return;
        }

        try {
          const accessToken = await ensureFreshAccessToken();
          await uploadClientCapabilities({
            serverUrl: config.server.url,
            accessToken,
            clientId: config.client.id,
            capabilities,
          });
          if (!options.json) print.line("  Uploaded to the server.\n\n");
        } catch (err) {
          // The clients row only exists after a `client:register` handshake, so
          // a probe run before the daemon has ever connected can 404 here. The
          // local probe result is still printed; surface the upload failure
          // without failing the whole command.
          const msg = err instanceof Error ? err.message : String(err);
          print.status("⚠️", `capabilities upload skipped: ${msg}`);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        print.line(`  Error: ${msg}\n`);
        process.exit(1);
      } finally {
        resetConfig();
        resetConfigMeta();
      }
    });
}
