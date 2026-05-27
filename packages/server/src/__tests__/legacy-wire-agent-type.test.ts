import { describe, expect, it } from "vitest";
import { legacyWireAgentType } from "../services/agent.js";

/**
 * Wire-compatibility helper for the `agent:pinned` WebSocket frame.
 * Translates a post-merge `(type, visibility)` pair back to the pre-merge
 * 3-value enum (`human` / `personal_assistant` / `autonomous_agent`) so
 * clients on ≤ 0.5.1 (whose strict zod enum rejects the post-merge `agent`
 * literal) can still decode the frame. Drop the helper and these tests once
 * every deployed client accepts `agent`.
 */
describe("legacyWireAgentType — wire-compat translation for agent:pinned", () => {
  it("returns 'human' for human rows regardless of visibility", () => {
    expect(legacyWireAgentType("human", "organization")).toBe("human");
    expect(legacyWireAgentType("human", "private")).toBe("human");
  });

  it("returns 'personal_assistant' for (agent, private) — the pre-merge PA framing", () => {
    expect(legacyWireAgentType("agent", "private")).toBe("personal_assistant");
  });

  it("returns 'autonomous_agent' for (agent, organization) — the pre-merge autonomous bot framing", () => {
    expect(legacyWireAgentType("agent", "organization")).toBe("autonomous_agent");
  });

  it("falls back to autonomous_agent when visibility is anything other than 'private'", () => {
    // Belt-and-braces against a future visibility value landing in the DB
    // before the helper is updated — biased toward the org default rather
    // than mis-rendering as a personal assistant on old clients.
    expect(legacyWireAgentType("agent", "unknown-future-value")).toBe("autonomous_agent");
  });
});
