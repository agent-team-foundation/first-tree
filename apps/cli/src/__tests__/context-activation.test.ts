import { describe, expect, it, vi } from "vitest";
import {
  activateExternalContext,
  BYO_CONTEXT_ADDITIONAL_CONTEXT_LIMIT,
  buildByoContextAdditionalContext,
  requireConnectedExternalContext,
} from "../core/context-integration/activation.js";

const project = { kind: "path" as const, root: "/work/app" };
const grant = { provider: "codex" as const, organizationId: "org-a", activationScope: { kind: "global" as const } };

describe("neutral multi-Team activation", () => {
  it("SessionStart injects a neutral router and does not validate or choose a Team", async () => {
    const validator = { validateMemberContextActivation: vi.fn() };
    const result = await activateExternalContext(
      validator,
      { provider: "codex", project },
      {
        resolveCandidates: () => [
          { grant, priority: "global" },
          { grant: { ...grant, organizationId: "org-b" }, priority: "global" },
        ],
      },
    );
    expect(result).toMatchObject({ outcome: "connected", candidateCount: 2 });
    expect(result.additionalContext).toContain("consumerKind: byo");
    expect(result.additionalContext).not.toContain("org-a");
    expect(validator.validateMemberContextActivation).not.toHaveBeenCalled();
  });

  it("fails closed without a local grant", async () => {
    await expect(
      activateExternalContext(
        { validateMemberContextActivation: vi.fn() },
        { provider: "codex", project },
        { resolveCandidates: () => [] },
      ),
    ).resolves.toMatchObject({ outcome: "disabled", reasonCode: "grant_missing" });
  });

  it("legacy direct guard refuses ambiguity and validates the sole local candidate", async () => {
    const validator = {
      validateMemberContextActivation: vi.fn().mockResolvedValue({
        schemaVersion: 2,
        outcome: "connected",
        team: { organizationId: "org-a", displayName: "A", role: "admin" },
      }),
    };
    await expect(
      requireConnectedExternalContext(
        validator,
        { provider: "codex", project },
        { resolveCandidates: () => [{ grant, priority: "global" }] },
      ),
    ).resolves.toMatchObject({ team: { organizationId: "org-a" }, grant });
    await expect(
      requireConnectedExternalContext(
        validator,
        { provider: "codex", project },
        {
          resolveCandidates: () => [
            { grant, priority: "global" },
            { grant: { ...grant, organizationId: "org-b" }, priority: "global" },
          ],
        },
      ),
    ).rejects.toMatchObject({ reasonCode: "route_required" });
  });

  it("standing context keeps trusted mode, fail-closed Read routing, and source-driven Write routing", () => {
    const context = buildByoContextAdditionalContext();
    expect(context).toContain("consumerKind: byo");
    expect(context).toContain("first-tree-read");
    expect(context).toContain("Selection is fail-closed");
    expect(context).toContain("first-tree-write");
    expect(context).toContain("Tree writes are source-driven");
    expect(context).toContain("External BYO provider session");
  });

  it("keeps standing context safely below the provider hook limit", () => {
    const contextBytes = Buffer.byteLength(buildByoContextAdditionalContext(), "utf8");
    expect(contextBytes).toBeLessThanOrEqual(BYO_CONTEXT_ADDITIONAL_CONTEXT_LIMIT - 128);
  });
});
