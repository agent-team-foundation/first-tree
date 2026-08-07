import { describe, expect, it } from "vitest";
import {
  contextIntegrationConfigSchema,
  contextIntegrationInstallJournalSchema,
  contextIntegrationInstallManifestSchema,
  contextIntegrationReleaseManifestSchema,
  legacyContextIntegrationConfigSchema,
} from "../index.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

describe("context integration contracts", () => {
  it("parses global and directory Team grants", () => {
    const parsed = contextIntegrationConfigSchema.parse({
      schemaVersion: 3,
      grants: [
        {
          provider: "codex",
          organizationId: "org_acme",
          activationScope: { kind: "directory", root: "/work/payments" },
        },
        {
          provider: "claude-code",
          organizationId: "org_acme",
          activationScope: { kind: "global" },
        },
      ],
    });
    expect(parsed.grants).toHaveLength(2);
  });

  it("rejects unsupported providers", () => {
    expect(
      contextIntegrationConfigSchema.safeParse({
        schemaVersion: 3,
        grants: [
          {
            provider: "remote",
            organizationId: "org_acme",
            activationScope: { kind: "global" },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("allows multiple Teams at the same activation scope", () => {
    const grants = [
      { provider: "codex", organizationId: "org_a", activationScope: { kind: "global" } },
      { provider: "codex", organizationId: "org_b", activationScope: { kind: "global" } },
    ];
    expect(contextIntegrationConfigSchema.safeParse({ schemaVersion: 3, grants }).success).toBe(true);
  });

  it("rejects duplicate provider + Team + activation scope identities", () => {
    expect(
      contextIntegrationConfigSchema.safeParse({
        schemaVersion: 3,
        grants: [
          { provider: "codex", organizationId: "org_a", activationScope: { kind: "global" } },
          { provider: "codex", organizationId: "org_a", activationScope: { kind: "global" } },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects a legacy migration with duplicate provider + checkout identities", () => {
    expect(
      legacyContextIntegrationConfigSchema.safeParse({
        schemaVersion: 1,
        bindings: [
          {
            provider: "codex",
            checkoutRoot: "/work/project",
            repositoryKey: "github.com/acme/one",
            organizationId: "org_a",
          },
          {
            provider: "codex",
            checkoutRoot: "/work/project",
            repositoryKey: "github.com/acme/two",
            organizationId: "org_b",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("requires policy digests in installed and release manifests", () => {
    expect(
      contextIntegrationInstallManifestSchema.parse({
        schemaVersion: 1,
        channel: "prod",
        provider: "codex",
        firstTreeVersion: "1.0.0",
        bundleVersion: "1.0.0",
        bundleDigest: DIGEST,
        policyDigest: DIGEST,
        adapterDigest: DIGEST,
        marketplaceName: "first-tree",
        pluginName: "first-tree-context",
        materializedInvocation: "/opt/first-tree/bin/first-tree",
        installedAt: "2026-07-28T00:00:00.000Z",
      }).policyDigest,
    ).toBe(DIGEST);

    expect(
      contextIntegrationInstallManifestSchema.safeParse({
        schemaVersion: 1,
        channel: "prod",
        provider: "codex",
        firstTreeVersion: "1.0.0",
        bundleVersion: "1.0.0",
        bundleDigest: DIGEST,
        policyDigest: DIGEST,
        adapterDigest: DIGEST,
        marketplaceName: "first-tree",
        pluginName: "first-tree-context",
        materializedInvocation: "",
        installedAt: "2026-07-28T00:00:00.000Z",
      }).success,
    ).toBe(false);

    expect(
      contextIntegrationReleaseManifestSchema.parse({
        schemaVersion: 1,
        version: "1.0.0",
        channel: "prod",
        bundleDigest: DIGEST,
        policyDigest: DIGEST,
        core: {
          digest: DIGEST,
          policy: { path: "policy/context-tree-policy.md", digest: DIGEST },
          skills: {
            "first-tree-read": { path: "skills/first-tree-read/SKILL.md", digest: DIGEST },
            "first-tree-write": { path: "skills/first-tree-write/SKILL.md", digest: DIGEST },
          },
        },
        providers: {
          codex: { adapterVersion: "1.0.0", adapterDigest: DIGEST, minimumVersion: "1.0.0" },
          "claude-code": { adapterVersion: "1.0.0", adapterDigest: DIGEST, minimumVersion: "1.0.0" },
        },
      }).policyDigest,
    ).toBe(DIGEST);
  });

  it("validates recoverable install journal phases without local paths", () => {
    expect(
      contextIntegrationInstallJournalSchema.parse({
        schemaVersion: 1,
        provider: "claude-code",
        operation: "repair",
        previousBundleDigest: DIGEST,
        targetBundleDigest: DIGEST,
        startedAt: "2026-07-28T00:00:00.000Z",
        phase: "provider_installing",
      }).phase,
    ).toBe("provider_installing");
  });
});
