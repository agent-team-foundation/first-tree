import { describe, expect, it } from "vitest";
import { pulseTickSchema } from "../schemas/pulse.js";

const zeroBucket = { workingCount: 0, errorMask: false };
const buckets32 = () => Array.from({ length: 32 }, () => ({ ...zeroBucket }));

describe("pulseTickSchema", () => {
  it("accepts a well-formed tick with one agent", () => {
    const res = pulseTickSchema.safeParse({
      type: "pulse:tick",
      organizationId: "org-1",
      agents: { "agent-1": buckets32() },
    });
    expect(res.success).toBe(true);
  });

  it("accepts an empty agents map (happens when a member has zero visible agents)", () => {
    const res = pulseTickSchema.safeParse({
      type: "pulse:tick",
      organizationId: "org-1",
      agents: {},
    });
    expect(res.success).toBe(true);
  });

  it("rejects buckets array whose length is not exactly 32", () => {
    const short = pulseTickSchema.safeParse({
      type: "pulse:tick",
      organizationId: "org-1",
      agents: { a: buckets32().slice(0, 31) },
    });
    const long = pulseTickSchema.safeParse({
      type: "pulse:tick",
      organizationId: "org-1",
      agents: { a: [...buckets32(), zeroBucket] },
    });
    expect(short.success).toBe(false);
    expect(long.success).toBe(false);
  });

  it("rejects a negative workingCount", () => {
    const bad = [{ workingCount: -1, errorMask: false }, ...buckets32().slice(1)];
    const res = pulseTickSchema.safeParse({
      type: "pulse:tick",
      organizationId: "org-1",
      agents: { a: bad },
    });
    expect(res.success).toBe(false);
  });

  it("rejects a non-integer workingCount", () => {
    const bad = [{ workingCount: 1.5, errorMask: false }, ...buckets32().slice(1)];
    const res = pulseTickSchema.safeParse({
      type: "pulse:tick",
      organizationId: "org-1",
      agents: { a: bad },
    });
    expect(res.success).toBe(false);
  });

  it("rejects a non-boolean errorMask", () => {
    const bad = [{ workingCount: 0, errorMask: 1 }, ...buckets32().slice(1)];
    const res = pulseTickSchema.safeParse({
      type: "pulse:tick",
      organizationId: "org-1",
      agents: { a: bad },
    });
    expect(res.success).toBe(false);
  });

  it("rejects a wrong type literal", () => {
    const res = pulseTickSchema.safeParse({
      type: "pulse:other",
      organizationId: "org-1",
      agents: {},
    });
    expect(res.success).toBe(false);
  });

  it("rejects missing organizationId", () => {
    const res = pulseTickSchema.safeParse({
      type: "pulse:tick",
      agents: {},
    });
    expect(res.success).toBe(false);
  });
});
