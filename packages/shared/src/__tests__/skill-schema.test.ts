import { describe, expect, it } from "vitest";
import { skillDescriptorSchema } from "../schemas/skill.js";

describe("skillDescriptorSchema", () => {
  const baseValid = { name: "review", description: "Pre-landing PR review", source: "user" as const };

  it("accepts a well-formed descriptor", () => {
    expect(skillDescriptorSchema.parse(baseValid)).toEqual(baseValid);
  });

  it("accepts a namespaced descriptor", () => {
    const out = skillDescriptorSchema.parse({ ...baseValid, namespace: "hyperframes", name: "gsap" });
    expect(out.namespace).toBe("hyperframes");
  });

  // Charset guard: schema MUST agree with `detectSlashTrigger`'s accept-set
  // in the web composer (`[A-Za-z0-9_-]`). A schema-passing skill whose
  // name contains spaces or `/` would be unreachable from the popover —
  // the user would type the bad char and the trigger would close
  // mid-query. Rejecting at schema is the only way to keep the contract
  // single-source.
  it("rejects a name containing whitespace", () => {
    expect(() => skillDescriptorSchema.parse({ ...baseValid, name: "weird name" })).toThrow(/A-Za-z0-9_-/);
  });

  it("rejects a name containing `/`", () => {
    expect(() => skillDescriptorSchema.parse({ ...baseValid, name: "foo/bar" })).toThrow(/A-Za-z0-9_-/);
  });

  it("rejects a name starting with `-` or `_`", () => {
    expect(() => skillDescriptorSchema.parse({ ...baseValid, name: "-foo" })).toThrow(/A-Za-z0-9_-/);
    expect(() => skillDescriptorSchema.parse({ ...baseValid, name: "_foo" })).toThrow(/A-Za-z0-9_-/);
  });

  it("applies the same charset to namespace", () => {
    expect(() => skillDescriptorSchema.parse({ ...baseValid, namespace: "bad ns" })).toThrow(/A-Za-z0-9_-/);
  });

  it("rejects an empty name", () => {
    expect(() => skillDescriptorSchema.parse({ ...baseValid, name: "" })).toThrow();
  });
});
