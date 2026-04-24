import { describe, expect, it } from "vitest";
import {
  agentRuntimeConfigPayloadSchema,
  DEFAULT_AGENT_RUNTIME_CONFIG_PAYLOAD,
} from "../schemas/agent-runtime-config.js";

/**
 * Lock the Hub-side default model. This default backs two separate paths:
 *   - `server.services.agent.createAgent` seeds fresh rows from this constant.
 *   - `agentRuntimeConfigPayloadSchema.parse({})` fills the same field when a
 *     payload arrives without `model` (e.g. partial PATCH + merge).
 *
 * Dropping back to `""` would regress agents to SDK's CLI fallback — which
 * in turn depends on the operator's local `~/.claude/settings.json`. For
 * fresh agents that haven't been touched by an admin, Hub should have a
 * deterministic answer, so this test pins it.
 */
describe("agent runtime config — default model", () => {
  it("DEFAULT_AGENT_RUNTIME_CONFIG_PAYLOAD.model is 'opus'", () => {
    expect(DEFAULT_AGENT_RUNTIME_CONFIG_PAYLOAD.model).toBe("opus");
  });

  it("schema fills model='opus' when parsing an empty object", () => {
    const parsed = agentRuntimeConfigPayloadSchema.parse({});
    expect(parsed.model).toBe("opus");
  });

  it("schema preserves explicit empty string (operator opt-out)", () => {
    // Empty string means "defer to SDK / local settings.json" — the hub
    // must not silently replace it with the default.
    const parsed = agentRuntimeConfigPayloadSchema.parse({ model: "" });
    expect(parsed.model).toBe("");
  });
});
