#!/usr/bin/env node

import { Command } from "commander";
import { AgentHubSDK, SdkError } from "../sdk.js";
import { fail, success } from "./output.js";

function resolveConfig(): { serverUrl: string; token: string } {
  const token = process.env.AGENT_HUB_TOKEN;
  if (!token) {
    fail("MISSING_TOKEN", "AGENT_HUB_TOKEN environment variable is required.", 2);
  }
  const serverUrl = process.env.AGENT_HUB_SERVER ?? "http://localhost:8000";
  return { serverUrl, token };
}

function createSdk(): AgentHubSDK {
  const config = resolveConfig();
  return new AgentHubSDK(config);
}

function handleError(error: unknown): never {
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

program.parse();
