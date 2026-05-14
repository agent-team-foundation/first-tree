import { describe, expect, it } from "vitest";
import { canManageAgentDetail } from "../access.js";

describe("agent detail access helpers", () => {
  it("allows admins to manage any visible agent", () => {
    expect(canManageAgentDetail({ managerId: "member-2" }, "member-1", "admin")).toBe(true);
  });

  it("allows the manager to manage their agent", () => {
    expect(canManageAgentDetail({ managerId: "member-1" }, "member-1", "member")).toBe(true);
  });

  it("blocks non-managers from manage-only configuration and lifecycle actions", () => {
    expect(canManageAgentDetail({ managerId: "member-2" }, "member-1", "member")).toBe(false);
  });
});
