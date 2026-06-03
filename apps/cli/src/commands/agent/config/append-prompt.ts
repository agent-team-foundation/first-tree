import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { fail, success } from "../../../cli/output.js";
import { ensureFreshAdminToken, resolveServerUrl } from "../../../core/bootstrap.js";
import { getAgentResources, patchAgentResources, resolveAgentRecord } from "./_shared/fetchers.js";

export function registerAgentConfigAppendPromptCommand(config: Command): void {
  config
    .command("append-prompt <agent>")
    .description("Replace the systemPrompt append text — reads from -f file or stdin")
    .option("-f, --file <path>", "Read prompt text from this file")
    .action(async (agentName: string, opts: { file?: string }) => {
      const serverUrl = resolveServerUrl(process.env.FIRST_TREE_SERVER_URL);
      const adminToken = await ensureFreshAdminToken();
      const { uuid } = await resolveAgentRecord(serverUrl, adminToken, agentName);
      let text: string;
      if (opts.file) {
        text = readFileSync(opts.file, "utf-8");
      } else if (!process.stdin.isTTY) {
        text = await new Promise<string>((resolve, reject) => {
          const chunks: Buffer[] = [];
          process.stdin.on("data", (c: Buffer) => chunks.push(c));
          process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
          process.stdin.on("error", reject);
        });
      } else {
        fail("MISSING_INPUT", "Provide -f <file> or pipe prompt text via stdin", 2);
      }
      const current = await getAgentResources(serverUrl, adminToken, uuid);
      const removedOrders: number[] = [];
      const remaining = current.bindings.filter((binding) => {
        const isLegacyAppend =
          binding.type === "prompt" &&
          binding.mode === "include" &&
          !binding.resourceId &&
          !binding.replacesResourceId &&
          binding.inlinePromptBody !== null &&
          binding.inlinePromptBody !== undefined;
        if (isLegacyAppend && binding.order !== undefined) removedOrders.push(binding.order);
        return !isLegacyAppend;
      });
      const nextBindings = [...remaining];
      if (text.length > 0) {
        nextBindings.push({
          type: "prompt",
          mode: "include",
          resourceId: null,
          inlinePromptBody: text,
          order: removedOrders.length > 0 ? Math.min(...removedOrders) : remaining.length + 1,
        });
      }
      const updated = await patchAgentResources(serverUrl, adminToken, uuid, {
        expectedVersion: current.version,
        bindings: nextBindings,
      });
      success({ agentId: uuid, version: updated.version, append_length: text.length });
    });
}
