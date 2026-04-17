import { describe, expect, it } from "vitest";
import {
  compareSkillVersions,
  extractMajorMinor,
} from "../../src/products/tree/engine/runtime/upgrader.js";

describe("extractMajorMinor", () => {
  it("returns major.minor from a full version", () => {
    expect(extractMajorMinor("0.2.5")).toBe("0.2");
    expect(extractMajorMinor("1.10.0")).toBe("1.10");
  });

  it("returns the input unchanged when already major.minor", () => {
    expect(extractMajorMinor("0.2")).toBe("0.2");
  });

  it("trims whitespace", () => {
    expect(extractMajorMinor("  0.2.0\n")).toBe("0.2");
  });
});

describe("compareSkillVersions", () => {
  it("treats matching major.minor as equal regardless of patch", () => {
    expect(compareSkillVersions("0.2", "0.2.0")).toBe(0);
    expect(compareSkillVersions("0.2", "0.2.5")).toBe(0);
    expect(compareSkillVersions("0.2.1", "0.2.5")).toBe(0);
  });

  it("flags installed as older when minor is lower", () => {
    expect(compareSkillVersions("0.1", "0.2.0")).toBe(-1);
    expect(compareSkillVersions("0.1.5", "0.2.0")).toBe(-1);
  });

  it("flags installed as newer when minor is higher", () => {
    expect(compareSkillVersions("0.3", "0.2.5")).toBe(1);
  });

  it("compares major version differences", () => {
    expect(compareSkillVersions("1.0", "0.9.9")).toBe(1);
    expect(compareSkillVersions("0.9", "1.0.0")).toBe(-1);
  });
});
