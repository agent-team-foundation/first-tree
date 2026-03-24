#!/usr/bin/env node

import { Command } from "commander";
import { registerConnectCommand } from "./connect.js";
import { success } from "./output.js";
import { registerStartCommand } from "./start.js";
import { createSdk, handleError } from "./util.js";

const program = new Command();

program.name("agent-hub").description("Agent Hub CLI — agent-facing entry point").version("0.1.0");

program
  .command("register")
  .description("Register this agent and return identity info")
  .action(async () => {
    try {
      const sdk = createSdk();
      const result = await sdk.register();
      success(result);
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("pull")
  .description("Pull pending messages from inbox")
  .option("-l, --limit <number>", "Maximum entries to return", "10")
  .option("-a, --ack", "Automatically ACK entries after pulling")
  .action(async (options: { limit: string; ack?: boolean }) => {
    try {
      const sdk = createSdk();
      const limit = Number.parseInt(options.limit, 10);
      if (Number.isNaN(limit) || limit < 1 || limit > 50) {
        const { fail } = await import("./output.js");
        fail("INVALID_LIMIT", "Limit must be between 1 and 50.", 2);
      }
      const result = await sdk.pull(limit);

      if (options.ack && result.entries.length > 0) {
        await Promise.all(result.entries.map((entry) => sdk.ack(entry.id)));
      }

      success(result);
    } catch (error) {
      handleError(error);
    }
  });

registerConnectCommand(program);
registerStartCommand(program);

program.parse();
