import { describe, expect, it } from "vitest";
import { sourceLabel, templateSourceLabel } from "../resource-source.js";

describe("resource source labels", () => {
  it("describes the stable rule that makes a resource apply", () => {
    expect(sourceLabel("agent_extra")).toBe("Added to this agent");
    expect(sourceLabel("inline_prompt")).toBe("Custom for this agent");
    expect(sourceLabel("team_available")).toBe("Enabled for this agent");
    expect(sourceLabel("team_recommended")).toBe("Team default");
  });

  it("labels Template-imported resources with the Template name when known", () => {
    expect(templateSourceLabel("PR Engineer")).toBe("Imported from PR Engineer · maintained by your team");
  });

  it("falls back to non-leaking generic copy when the Template is unknown", () => {
    expect(templateSourceLabel(null)).toBe("Imported from a template · maintained by your team");
  });
});
