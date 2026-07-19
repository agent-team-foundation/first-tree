import { describe, expect, it } from "vitest";
import {
  CONTEXT_TREE_SEED_PREFLIGHT_ERROR_CODES,
  contextTreeSeedPreflightErrorCodeSchema,
  contextTreeSeedPreflightRequestSchema,
  contextTreeSeedPreflightResponseSchema,
} from "../schemas/context-tree-seed.js";

describe("Context Tree Seed preflight schemas", () => {
  it("keeps the admission request empty so callers cannot choose authority", () => {
    expect(contextTreeSeedPreflightRequestSchema.parse({})).toEqual({});
    expect(contextTreeSeedPreflightRequestSchema.safeParse({ role: "admin" }).success).toBe(false);
    expect(contextTreeSeedPreflightRequestSchema.safeParse({ binding: {} }).success).toBe(false);
  });

  it("accepts strict unbound and bound current-state responses", () => {
    expect(
      contextTreeSeedPreflightResponseSchema.parse({
        organizationId: "team-a",
        state: { status: "unbound", branch: "main" },
      }),
    ).toEqual({ organizationId: "team-a", state: { status: "unbound", branch: "main" } });

    expect(
      contextTreeSeedPreflightResponseSchema.parse({
        organizationId: "team-a",
        state: {
          status: "bound",
          binding: { repo: "https://github.com/acme/context-tree.git", branch: "main" },
        },
      }),
    ).toEqual({
      organizationId: "team-a",
      state: {
        status: "bound",
        binding: { repo: "https://github.com/acme/context-tree.git", branch: "main" },
      },
    });
  });

  it("rejects mixed, unsafe, or caller-invented state", () => {
    expect(
      contextTreeSeedPreflightResponseSchema.safeParse({
        organizationId: "team-a",
        state: {
          status: "unbound",
          branch: "main",
          binding: { repo: "https://github.com/acme/context-tree.git", branch: "main" },
        },
      }).success,
    ).toBe(false);
    expect(
      contextTreeSeedPreflightResponseSchema.safeParse({
        organizationId: "team-a",
        state: { status: "bound", binding: { repo: "https://user:secret@github.com/acme/tree.git", branch: "main" } },
      }).success,
    ).toBe(false);
    expect(
      contextTreeSeedPreflightResponseSchema.safeParse({
        organizationId: "team-a",
        state: { status: "seeded", binding: null },
      }).success,
    ).toBe(false);
  });

  it("pins the stable Server error-code set", () => {
    expect(CONTEXT_TREE_SEED_PREFLIGHT_ERROR_CODES).toEqual([
      "CONTEXT_TREE_SEED_AUTHORITY_FAILED",
      "CONTEXT_TREE_SEED_NEEDS_ADMIN",
      "CONTEXT_TREE_SEED_CONFIGURATION_INVALID",
    ]);
    for (const code of CONTEXT_TREE_SEED_PREFLIGHT_ERROR_CODES) {
      expect(contextTreeSeedPreflightErrorCodeSchema.parse(code)).toBe(code);
    }
  });
});
