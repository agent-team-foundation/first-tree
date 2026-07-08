import { generateKeyPairSync } from "node:crypto";
import type { ContextTreeSnapshot } from "@first-tree/shared";
import { beforeAll, describe, expect, it } from "vitest";
import type { ContextTreeBinding } from "../services/context-tree-snapshot.js";
import type { InstallationRow } from "../services/github-app-installations.js";
import {
  type ContextTreeInstallationTokenResult,
  decorateSnapshotWithMintGuidance,
  mintContextTreeInstallationToken,
} from "../services/github-app-token.js";

/**
 * `mintContextTreeInstallationToken` is a pure transform: given an
 * installation row + App credentials, decide whether to mint and ship
 * a token. No DB access — route handlers do the `findInstallationByOrg`
 * lookup and pass the row in. Tests construct fixtures directly and
 * inject a `fetcher` for the GitHub round-trip.
 */
describe("services/github-app-token", () => {
  let appId: string;
  let privateKeyPem: string;

  beforeAll(() => {
    appId = "424242";
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    privateKeyPem = privateKey;
  });

  describe("mintContextTreeInstallationToken", () => {
    it("returns no-app-config when the deployment has no GitHub App configured", async () => {
      const result = await mintContextTreeInstallationToken(installationFixture(), undefined);
      expect(result).toEqual({ ok: false, reason: "no-app-config" });
    });

    it("returns no-installation when the caller passes no installation row", async () => {
      const result = await mintContextTreeInstallationToken(null, { appId, privateKeyPem });
      expect(result).toEqual({ ok: false, reason: "no-installation" });
    });

    it("returns suspended when the installation is suspended upstream", async () => {
      const installation = installationFixture({ suspendedAt: new Date() });
      const result = await mintContextTreeInstallationToken(installation, { appId, privateKeyPem });
      expect(result).toEqual({ ok: false, reason: "suspended" });
    });

    it("returns mint-failed with a GitHub status when GitHub rejects the mint", async () => {
      const installation = installationFixture({ installationId: 7777 });
      const fetcher: typeof fetch = async () =>
        new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
      const result = await mintContextTreeInstallationToken(installation, { appId, privateKeyPem }, { fetcher });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected mint to fail");
      expect(result.reason).toBe("mint-failed");
      expect(result.detail).toContain("401");
    });

    it("returns the minted installation token on success", async () => {
      const installation = installationFixture({ installationId: 7777 });
      const calls: string[] = [];
      const fetcher: typeof fetch = async (url) => {
        calls.push(String(url));
        return new Response(
          JSON.stringify({
            token: "ghs_installation_token",
            expires_at: "2026-05-15T01:00:00Z",
            permissions: { contents: "read" },
            repository_selection: "selected",
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      };
      const result = await mintContextTreeInstallationToken(installation, { appId, privateKeyPem }, { fetcher });
      expect(result).toEqual({
        ok: true,
        token: "ghs_installation_token",
        permissions: { contents: "read" },
        repositorySelection: "selected",
      });
      expect(calls).toEqual(["https://api.github.com/app/installations/7777/access_tokens"]);
    });
  });

  describe("decorateSnapshotWithMintGuidance", () => {
    const githubBinding: ContextTreeBinding = { repo: "agent-team-foundation/first-tree-context", branch: "main" };

    it("returns the snapshot unchanged when the mint succeeded", () => {
      const snapshot = unavailableSnapshot("First Tree could not sync the configured Context Tree repo.");
      const decorated = decorateSnapshotWithMintGuidance(snapshot, githubBinding, {
        ok: true,
        token: "ghs_t",
        permissions: {},
        repositorySelection: "all",
      });
      expect(decorated).toBe(snapshot);
    });

    it("returns the snapshot unchanged when it is not unavailable", () => {
      const snapshot: ContextTreeSnapshot = { ...unavailableSnapshot("ok"), snapshotStatus: "active" };
      const decorated = decorateSnapshotWithMintGuidance(snapshot, githubBinding, {
        ok: false,
        reason: "no-installation",
      });
      expect(decorated).toBe(snapshot);
    });

    it("leaves no-app-config snapshots untouched (public-repo path)", () => {
      const snapshot = unavailableSnapshot("First Tree could not sync the configured Context Tree repo.");
      const decorated = decorateSnapshotWithMintGuidance(snapshot, githubBinding, {
        ok: false,
        reason: "no-app-config",
      });
      expect(decorated).toBe(snapshot);
    });

    it("does not append App guidance when no repo is configured", () => {
      const snapshot = unavailableSnapshot("Context Tree is not configured.");
      const decorated = decorateSnapshotWithMintGuidance(snapshot, {}, { ok: false, reason: "no-installation" });
      expect(decorated).toBe(snapshot);
    });

    it("does not append App guidance when binding uses a localPath", () => {
      const snapshot = unavailableSnapshot("Context Tree checkout not found at /tmp/tree.");
      const decorated = decorateSnapshotWithMintGuidance(
        snapshot,
        { repo: "agent-team-foundation/first-tree-context", localPath: "/tmp/tree" },
        { ok: false, reason: "no-installation" },
      );
      expect(decorated).toBe(snapshot);
    });

    it("does not append App guidance for a non-GitHub remote", () => {
      const snapshot = unavailableSnapshot("First Tree could not sync the configured Context Tree repo.");
      const decorated = decorateSnapshotWithMintGuidance(
        snapshot,
        { repo: "https://gitlab.com/example/tree", branch: "main" },
        { ok: false, reason: "no-installation" },
      );
      expect(decorated).toBe(snapshot);
    });

    it("appends install-guidance for no-installation", () => {
      const snapshot = unavailableSnapshot("First Tree could not sync the configured Context Tree repo.");
      const decorated = decorateSnapshotWithMintGuidance(snapshot, githubBinding, {
        ok: false,
        reason: "no-installation",
      });
      expect(decorated.contextStatus.detail).toContain("Install the First Tree GitHub App from Team Settings");
    });

    it("appends unsuspend-guidance for suspended", () => {
      const snapshot = unavailableSnapshot("First Tree could not sync the configured Context Tree repo.");
      const decorated = decorateSnapshotWithMintGuidance(snapshot, githubBinding, { ok: false, reason: "suspended" });
      expect(decorated.contextStatus.detail).toContain("suspended");
    });

    it("appends mint-failed detail when GitHub rejected the mint", () => {
      const snapshot = unavailableSnapshot("First Tree could not sync the configured Context Tree repo.");
      const failure: ContextTreeInstallationTokenResult = {
        ok: false,
        reason: "mint-failed",
        detail: "GitHub returned 403 when minting an installation token.",
      };
      const decorated = decorateSnapshotWithMintGuidance(snapshot, githubBinding, failure);
      expect(decorated.contextStatus.detail).toContain("GitHub returned 403");
    });
  });
});

function installationFixture(overrides: Partial<InstallationRow> = {}): InstallationRow {
  const now = new Date();
  return {
    id: "01000000-0000-7000-8000-000000000000",
    installationId: 1,
    accountType: "Organization",
    accountLogin: "acme",
    accountGithubId: 999,
    installerGithubId: null,
    requesterGithubId: null,
    hubOrganizationId: "org-1",
    permissions: { contents: "read" },
    events: ["push"],
    suspendedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function unavailableSnapshot(detail: string): ContextTreeSnapshot {
  return {
    repo: "agent-team-foundation/first-tree-context",
    branch: "main",
    headCommit: null,
    syncedAt: null,
    snapshotStatus: "unavailable",
    contextStatus: { label: "Team context unavailable", detail, severity: "error" },
    summary: { addedCount: 0, editedCount: 0, removedCount: 0, changedNodeCount: 0 },
    usage: { windowDays: 7, agentCount: 0, usageCount: 0, recentEvents: [] },
    io: {
      windowDays: 7,
      summary: {
        read: { agentCount: 0, eventCount: 0, targetCount: 0 },
        write: { agentCount: 0, eventCount: 0, targetCount: 0 },
      },
      agents: [],
      recentEvents: [],
      writes: [],
      writesTotal: 0,
      skipped: { windowDays: 7, totalEventCount: 0, reasons: [] },
    },
    updates: [],
    nodes: [],
    edges: [],
    changes: [],
  };
}
