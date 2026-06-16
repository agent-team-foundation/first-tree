import { describe, expect, it } from "vitest";
import { agentConfigSchema, DEFAULT_AGENT_CONCURRENCY, DEFAULT_AGENT_MAX_SESSIONS } from "../agent-config.js";
import { buildZodSchema } from "../resolver.js";

describe("agentConfigSchema", () => {
  it("defaults session guardrails to effectively unbounded product values", () => {
    expect(DEFAULT_AGENT_CONCURRENCY).toBe(99);
    expect(DEFAULT_AGENT_MAX_SESSIONS).toBe(99);

    const parsed = buildZodSchema(agentConfigSchema).parse({ agentId: "agent-1" });

    expect(parsed).toMatchObject({
      concurrency: DEFAULT_AGENT_CONCURRENCY,
      session: {
        max_sessions: DEFAULT_AGENT_MAX_SESSIONS,
      },
    });
  });
});
