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
      const updated = await patchAgentResources(serverUrl, adminToken, uuid, {
        expectedVersion: current.version,
        bindings: [
          ...current.bindings,
          {
            type: "prompt",
            mode: "include",
            resourceId: null,
            inlinePromptBody: text,
            order: current.bindings.length + 1,
          },
        ],
      });
      success({ agentId: uuid, version: updated.version, append_length: text.length });
    });
}
