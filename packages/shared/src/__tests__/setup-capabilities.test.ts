import { describe, expect, it } from "vitest";
import {
  setupActionKindSchema,
  setupBlockerCodeSchema,
  setupBlockerSchema,
  setupContextTreeBindingSchema,
  setupRepositoryAutomationProviderSchema,
  type TeamSetupCapabilities,
  teamSetupCapabilitiesSchema,
} from "../index.js";

const observedAt = "2026-07-23T08:00:00.000Z";

function validCapabilities(): TeamSetupCapabilities {
  return {
    organizationId: "org-1",
    repositoryAutomation: {
      providers: [
        {
          provider: "github",
          adoption: "enabled",
          health: "ready",
          blockers: [],
          observedAt,
        },
        {
          provider: "gitlab",
          adoption: "available",
          health: "not_observed",
          blockers: [],
          observedAt,
        },
      ],
    },
    contextTree: {
      binding: {
        state: "bound",
        provider: "github",
        repo: "https://github.com/acme/context-tree.git",
        branch: "main",
      },
      blockers: [],
      automaticReview: {
        adoption: "enabled",
        health: "ready",
        reviewerAgent: {
          uuid: "01900000-0000-7000-8000-000000000001",
          displayName: "Context Reviewer",
        },
        blockers: [],
        observedAt,
      },
    },
  };
}

describe("TeamSetupCapabilities public contract", () => {
  it("runtime-parses the exported complete contract", () => {
    const value = validCapabilities();

    expect(teamSetupCapabilitiesSchema.parse(value)).toEqual(value);
    expect(setupRepositoryAutomationProviderSchema.parse(value.repositoryAutomation.providers[0])).toEqual(
      value.repositoryAutomation.providers[0],
    );
    expect(setupContextTreeBindingSchema.parse(value.contextTree.binding)).toEqual(value.contextTree.binding);
    expect(setupActionKindSchema.parse("open_tree_setup_chat")).toBe("open_tree_setup_chat");
    expect(setupBlockerCodeSchema.parse("github_app_not_configured")).toBe("github_app_not_configured");
    expect(setupBlockerCodeSchema.parse("github_webhook_events_missing")).toBe("github_webhook_events_missing");
  });

  it("fails closed on unknown fields at every public object boundary", () => {
    const value = validCapabilities();

    expect(teamSetupCapabilitiesSchema.safeParse({ ...value, callerRole: "admin" }).success).toBe(false);
    expect(
      setupRepositoryAutomationProviderSchema.safeParse({
        ...value.repositoryAutomation.providers[0],
        setupUrl: "/settings/integrations/github",
      }).success,
    ).toBe(false);
    expect(
      setupBlockerSchema.safeParse({
        code: "github_app_suspended",
        resolutionOwner: "admin",
        actionKind: "manage_github_installation",
        message: "Reconnect GitHub",
      }).success,
    ).toBe(false);
  });

  it("rejects illegal unions, enum values, timestamps, and provider sets", () => {
    const value = validCapabilities();

    expect(setupContextTreeBindingSchema.safeParse({ state: "unbound", repo: "secret" }).success).toBe(false);
    expect(
      teamSetupCapabilitiesSchema.safeParse({
        ...value,
        repositoryAutomation: {
          providers: [value.repositoryAutomation.providers[0], value.repositoryAutomation.providers[0]],
        },
      }).success,
    ).toBe(false);
    expect(
      setupRepositoryAutomationProviderSchema.safeParse({
        ...value.repositoryAutomation.providers[0],
        health: "unknown",
      }).success,
    ).toBe(false);
    expect(
      setupRepositoryAutomationProviderSchema.safeParse({
        ...value.repositoryAutomation.providers[0],
        observedAt: "yesterday",
      }).success,
    ).toBe(false);
  });
});
