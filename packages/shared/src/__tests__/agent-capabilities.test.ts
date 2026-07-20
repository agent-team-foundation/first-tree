import { describe, expect, it } from "vitest";
import {
  AGENT_CAPABILITIES,
  agentCapabilitiesSchema,
  agentCapabilitySchema,
  agentSourceSchema,
  createManagedAgentSchema,
  findReservedAgentMetadataKey,
  RESERVED_AGENT_METADATA_KEYS,
  setAgentCapabilitiesSchema,
  userAgentMetadataSchema,
} from "../schemas/agent.js";

describe("agent capabilities (#1885)", () => {
  it("marks agentCapabilities and createdBy as reserved metadata keys", () => {
    expect(RESERVED_AGENT_METADATA_KEYS).toContain("agentCapabilities");
    expect(RESERVED_AGENT_METADATA_KEYS).toContain("createdBy");
  });

  it("rejects reserved keys on the free-form metadata field (write-protection)", () => {
    expect(findReservedAgentMetadataKey({ agentCapabilities: ["provision-agents"] })).toBe("agentCapabilities");
    expect(findReservedAgentMetadataKey({ createdBy: { agentId: "a" } })).toBe("createdBy");
    expect(userAgentMetadataSchema.safeParse({ agentCapabilities: ["provision-agents"] }).success).toBe(false);
    expect(userAgentMetadataSchema.safeParse({ createdBy: { agentId: "a" } }).success).toBe(false);
    // A benign key is still accepted.
    expect(userAgentMetadataSchema.safeParse({ note: "ok" }).success).toBe(true);
  });

  it("validates the capability value against a whitelist", () => {
    expect(agentCapabilitySchema.safeParse(AGENT_CAPABILITIES.PROVISION_AGENTS).success).toBe(true);
    expect(agentCapabilitySchema.safeParse("make-me-root").success).toBe(false);
    expect(agentCapabilitiesSchema.safeParse(["provision-agents"]).success).toBe(true);
    expect(agentCapabilitiesSchema.safeParse([]).success).toBe(true);
    expect(agentCapabilitiesSchema.safeParse(["provision-agents", "nope"]).success).toBe(false);
    expect(setAgentCapabilitiesSchema.safeParse({ capabilities: ["provision-agents"] }).success).toBe(true);
  });

  it("adds `agent-api` to the agent source enum", () => {
    expect(agentSourceSchema.safeParse("agent-api").success).toBe(true);
    expect(agentSourceSchema.safeParse("admin-api").success).toBe(true);
  });

  it("createManagedAgentSchema strips scope-widening fields (org/manager/type/source/metadata)", () => {
    const parsed = createManagedAgentSchema.parse({
      name: "teammate",
      displayName: "Teammate",
      runtimeProvider: "claude-code",
      // Attempts to widen scope — must NOT survive parsing.
      organizationId: "other-org",
      managerId: "other-member",
      type: "human",
      source: "admin-api",
      metadata: { agentCapabilities: ["provision-agents"] },
    });
    expect(parsed.name).toBe("teammate");
    expect(parsed).not.toHaveProperty("organizationId");
    expect(parsed).not.toHaveProperty("managerId");
    expect(parsed).not.toHaveProperty("type");
    expect(parsed).not.toHaveProperty("source");
    expect(parsed).not.toHaveProperty("metadata");
  });
});
