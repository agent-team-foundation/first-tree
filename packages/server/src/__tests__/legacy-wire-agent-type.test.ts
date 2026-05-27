import { describe, expect, it } from "vitest";
import { legacyWireAgentType } from "../services/agent.js";

/**
 * Wire-compatibility helper for the `agent:pinned` WebSocket frame.
 * Translates the post-merge `agents.type` value back into the pre-merge
 * 3-value enum so clients on ≤ 0.5.1 (whose strict zod enum rejects the
 * post-merge `agent` literal) can still decode the frame. Non-human
 * rows are uniformly mapped to `personal_assistant` — see the helper
 * doc-comment for why this is intentionally NOT derived from
 * `visibility`. Drop the helper and these tests once every deployed
 * client accepts `agent`.
 */
describe("legacyWireAgentType — wire-compat translation for agent:pinned", () => {
  it("returns 'human' for human rows", () => {
    expect(legacyWireAgentType("human")).toBe("human");
  });

  it("returns 'personal_assistant' for every non-human row", () => {
    // Picked because today's data is overwhelmingly PA; for the rare
    // autonomous bot the only knock-on effect on a 0.5.1 client is a
    // cosmetic "personal assistant" string in the generated CLAUDE.md.
    expect(legacyWireAgentType("agent")).toBe("personal_assistant");
  });

  it("treats any unknown future non-human type the same way", () => {
    // Belt-and-braces: a hypothetical future non-human row type still
    // lands on the legacy PA label rather than silently slipping through
    // as an unknown enum value the old client would reject.
    expect(legacyWireAgentType("some-future-type")).toBe("personal_assistant");
  });
});
