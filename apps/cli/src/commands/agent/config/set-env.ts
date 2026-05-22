import type { Command } from "commander";
import { fail, success } from "../../../cli/output.js";
import { ensureFreshAdminToken, resolveServerUrl } from "../../../core/bootstrap.js";
import { getCurrent, patchConfig, resolveAgentRecord } from "./_shared/fetchers.js";

export function registerAgentConfigSetEnvCommand(config: Command): void {
  config
    .command("set-env <agent> <kv>")
    .description("Set an env variable: KEY=VALUE. Use --sensitive for secrets.")
    .option("--sensitive", "Mark this value as sensitive (encrypted at rest, masked in echo)")
    .action(async (agentName: string, kv: string, opts: { sensitive?: boolean }) => {
      const serverUrl = resolveServerUrl(process.env.FIRST_TREE_SERVER_URL);
      const adminToken = await ensureFreshAdminToken();
      const { uuid } = await resolveAgentRecord(serverUrl, adminToken, agentName);
      const eqIdx = kv.indexOf("=");
      if (eqIdx <= 0) fail("BAD_KV", "Expected KEY=VALUE", 2);
      const key = kv.slice(0, eqIdx);
      const value = kv.slice(eqIdx + 1);
      const current = await getCurrent(serverUrl, adminToken, uuid);
      const remaining = current.payload.env.filter((e) => e.key !== key);
      const updated = await patchConfig(serverUrl, adminToken, uuid, current.version, {
        env: [...remaining, { key, value, sensitive: opts.sensitive ?? false }],
      });
      success({ agentId: updated.agentId, version: updated.version, env: key });
    });
}
