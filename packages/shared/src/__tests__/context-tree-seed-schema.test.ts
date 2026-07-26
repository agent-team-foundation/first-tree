import { describe, expect, it } from "vitest";
import {
  CONTEXT_TREE_SEED_PREFLIGHT_ERROR_CODES,
  contextTreeSeedPreflightErrorCodeSchema,
  contextTreeSeedPreflightRequestSchema,
  contextTreeSeedPreflightResponseSchema,
} from "../schemas/context-tree-seed.js";

describe("Context Tree Seed preflight schemas", () => {
  it("accepts no caller-selected authority or repository target", () => {
    expect(contextTreeSeedPreflightRequestSchema.parse({})).toEqual({});
    expect(contextTreeSeedPreflightRequestSchema.safeParse({ target: {} }).success).toBe(false);
    expect(contextTreeSeedPreflightRequestSchema.safeParse({ role: "admin" }).success).toBe(false);
    expect(contextTreeSeedPreflightRequestSchema.safeParse({ binding: {} }).success).toBe(false);
  });

  it("accepts strict unbound and bound current-state responses", () => {
    expect(
      contextTreeSeedPreflightResponseSchema.parse({
        organizationId: "team-a",
        state: { status: "unbound", branch: "main" },
        gitlabConnection: null,
      }),
    ).toEqual({
      organizationId: "team-a",
      state: { status: "unbound", branch: "main" },
      gitlabConnection: null,
    });

    expect(
      contextTreeSeedPreflightResponseSchema.parse({
        organizationId: "team-a",
        state: {
          status: "bound",
          binding: { repo: "https://github.com/acme/context-tree.git", branch: "main" },
        },
        gitlabConnection: { id: "connection-1", instanceOrigin: "https://gitlab.internal:8443" },
      }),
    ).toEqual({
      organizationId: "team-a",
      state: {
        status: "bound",
        binding: { repo: "https://github.com/acme/context-tree.git", branch: "main" },
      },
      gitlabConnection: { id: "connection-1", instanceOrigin: "https://gitlab.internal:8443" },
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
