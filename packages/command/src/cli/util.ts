import { AgentHubSDK, SdkError } from "@agent-hub/client";
import { fail } from "./output.js";

export function resolveConfig(): { serverUrl: string; token: string } {
  const token = process.env.AGENT_HUB_TOKEN;
  if (!token) {
    fail("MISSING_TOKEN", "AGENT_HUB_TOKEN environment variable is required.", 2);
  }
  const serverUrl = process.env.AGENT_HUB_SERVER ?? "http://localhost:8000";
  return { serverUrl, token };
}

export function createSdk(): AgentHubSDK {
  const config = resolveConfig();
  return new AgentHubSDK(config);
}

export function handleError(error: unknown): never {
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

/** Parse and validate a numeric limit option from Commander string. */
export function parseLimit(value: string, max: number): number {
  const limit = Number.parseInt(value, 10);
  if (Number.isNaN(limit) || limit < 1 || limit > max) {
    fail("INVALID_LIMIT", `Limit must be between 1 and ${max}.`, 2);
  }
  return limit;
}

/** Write a log line to stderr. */
export function log(tag: string, message: string): void {
  process.stderr.write(`[${tag}] ${message}\n`);
}
