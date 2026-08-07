import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchExactScope,
  readContextRouteReceipt,
  resolveContextRoute,
} from "../core/context-integration/context-route.js";

const SESSION_RECEIPT = "server-signed-session-candidate-receipt-value";
const ACCOUNT_CLIENT_ID = "client_1234abcd";

const roots: string[] = [];
const originalHome = process.env.FIRST_TREE_HOME;
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.FIRST_TREE_HOME;
  else process.env.FIRST_TREE_HOME = originalHome;
});

function tree(scopeBody: string): string {
  const root = mkdtempSync(join(tmpdir(), "context-route-tree-"));
  roots.push(root);
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  writeFileSync(join(root, "NODE.md"), "---\ntitle: Root\nowners: [admin]\n---\n");
  writeFileSync(join(root, "SCOPE.md"), `---\nschemaVersion: 1\n---\n${scopeBody}\n`);
  writeFileSync(join(root, "private-node.md"), "must not be returned by routing\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "tree"], { cwd: root });
  return root;
}

describe("BYO SCOPE router", () => {
  it("batch-validates only the session candidate and returns its complete exact SCOPE body", async () => {
    const home = mkdtempSync(join(tmpdir(), "context-route-home-"));
    roots.push(home);
    process.env.FIRST_TREE_HOME = home;
    mkdirSync(join(home, "state"), { recursive: true });
    expect(existsSync(join(home, "state", "context", "session-receipts"))).toBe(false);
    tree("This Tree covers customer research, contracts, and operating decisions.");
    const batch = vi.fn().mockResolvedValue({
      schemaVersion: 1,
      candidates: [
        {
          organizationId: "org-session",
          outcome: "connected",
          team: { organizationId: "org-session", displayName: "Research", role: "member" },
          binding: { provider: "github", repo: "https://github.com/acme/research", branch: "main" },
        },
      ],
    });
    const result = await resolveContextRoute(
      {
        validateMemberContextSessionCandidate: batch,
        validateMemberContextActivation: vi.fn(),
        getMemberContextTreeSetting: vi.fn(),
      },
      {
        provider: "codex",
        project: { kind: "path", root: "/tmp/session" },
        sessionCandidateReceipt: SESSION_RECEIPT,
      },
      {
        readAccountClientId: () => ACCOUNT_CLIENT_ID,
        fetchScope: () => ({
          commit: "a".repeat(40),
          scope: {
            schemaVersion: 1,
            relatedRepositories: [],
            body: "This Tree covers customer research, contracts, and operating decisions.",
          },
        }),
      },
    );
    expect(batch).toHaveBeenCalledWith(
      {
        schemaVersion: 1,
        provider: "codex",
        project: { kind: "path", root: "/tmp/session" },
        receipt: SESSION_RECEIPT,
      },
      { retry: false, timeoutMs: 10_000 },
    );
    expect(result.candidates[0]?.scope.body).toContain("customer research");
    expect(JSON.stringify(result)).not.toContain("private-node");
    const candidateId = result.candidates[0]?.candidateId;
    if (!candidateId) throw new Error("expected session candidate");
    expect(readContextRouteReceipt(candidateId, ACCOUNT_CLIENT_ID)).toMatchObject({ organizationId: "org-session" });
    expect(() => readContextRouteReceipt(candidateId, "client_11223344")).toThrow("invalid or expired");
  });

  it("fails closed when the Server rejects a tampered session candidate", async () => {
    const home = mkdtempSync(join(tmpdir(), "context-route-home-"));
    roots.push(home);
    process.env.FIRST_TREE_HOME = home;
    const authority = vi.fn().mockRejectedValue(new Error("Invalid or expired Context session candidate receipt."));
    await expect(
      resolveContextRoute(
        {
          validateMemberContextSessionCandidate: authority,
          validateMemberContextActivation: vi.fn(),
          getMemberContextTreeSetting: vi.fn(),
        },
        {
          provider: "codex",
          project: { kind: "path", root: "/tmp/session" },
          sessionCandidateReceipt: `${SESSION_RECEIPT}-tampered`,
        },
        { readAccountClientId: () => ACCOUNT_CLIENT_ID },
      ),
    ).rejects.toThrow("Invalid or expired");
    expect(authority).toHaveBeenCalledOnce();
  });

  it("marks a candidate unavailable when root SCOPE.md cannot be read", async () => {
    const home = mkdtempSync(join(tmpdir(), "context-route-home-"));
    roots.push(home);
    process.env.FIRST_TREE_HOME = home;
    const repository = tree("temporary");
    rmSync(join(repository, "SCOPE.md"));
    execFileSync("git", ["add", "-A"], { cwd: repository });
    execFileSync("git", ["commit", "-m", "remove scope"], { cwd: repository });
    const result = await resolveContextRoute(
      {
        validateMemberContextSessionCandidate: vi.fn().mockResolvedValue({
          schemaVersion: 1,
          candidates: [
            {
              organizationId: "org-a",
              outcome: "connected",
              team: { organizationId: "org-a", displayName: "A", role: "admin" },
              binding: { provider: "github", repo: "https://github.com/acme/a", branch: "main" },
            },
          ],
        }),
        validateMemberContextActivation: vi.fn(),
        getMemberContextTreeSetting: vi.fn(),
      },
      {
        provider: "codex",
        project: { kind: "path", root: "/work" },
        sessionCandidateReceipt: SESSION_RECEIPT,
      },
      {
        readAccountClientId: () => ACCOUNT_CLIENT_ID,
        fetchScope: () => {
          throw new Error("Root SCOPE.md is missing");
        },
      },
    );
    expect(result.candidates).toEqual([]);
    expect(result.unavailable[0]?.reason).toContain("SCOPE.md");
    expect(result.selectionBlocked).toBe(true);
    expect(result.instruction).toContain("no remaining candidate may be selected automatically");
  });

  it("rejects an exact root SCOPE blob that is not valid UTF-8", () => {
    const repository = tree("temporary");
    writeFileSync(
      join(repository, "SCOPE.md"),
      Buffer.concat([Buffer.from("---\nschemaVersion: 1\n---\n", "utf8"), Buffer.from([0xc3, 0x28])]),
    );
    execFileSync("git", ["add", "SCOPE.md"], { cwd: repository });
    execFileSync("git", ["commit", "-m", "invalid utf8 scope"], { cwd: repository });

    expect(() =>
      fetchExactScope({
        provider: "github",
        repo: repository,
        branch: "main",
      }),
    ).toThrow("Root SCOPE.md is not valid UTF-8");
  });

  it("blocks automatic selection when one peer is readable and another is unavailable", async () => {
    const home = mkdtempSync(join(tmpdir(), "context-route-home-"));
    roots.push(home);
    process.env.FIRST_TREE_HOME = home;
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(
      join(home, "config", "context.yaml"),
      "schemaVersion: 3\ngrants:\n  - provider: codex\n    organizationId: org-a\n    activationScope: { kind: global }\n  - provider: codex\n    organizationId: org-b\n    activationScope: { kind: global }\n",
    );
    const result = await resolveContextRoute(
      {
        validateMemberContextRouteCandidates: vi.fn().mockResolvedValue({
          schemaVersion: 1,
          candidates: [
            {
              organizationId: "org-a",
              outcome: "connected",
              team: { organizationId: "org-a", displayName: "A", role: "member" },
              binding: { provider: "github", repo: "https://github.com/acme/a", branch: "main" },
            },
            {
              organizationId: "org-b",
              outcome: "unavailable",
              reasonCode: "not_member",
              message: "membership service unavailable",
            },
          ],
        }),
        validateMemberContextActivation: vi.fn(),
        getMemberContextTreeSetting: vi.fn(),
      },
      { provider: "codex", project: { kind: "path", root: "/work" } },
      {
        readAccountClientId: () => ACCOUNT_CLIENT_ID,
        assertAdapterReady: vi.fn(),
        fetchScope: () => ({
          commit: "a".repeat(40),
          scope: { schemaVersion: 1, relatedRepositories: [], body: "Clearly matches this task." },
        }),
      },
    );
    expect(result.candidates).toHaveLength(1);
    expect(result.unavailable).toEqual([{ organizationId: "org-b", reason: "membership service unavailable" }]);
    expect(result.selectionBlocked).toBe(true);
    expect(result.instruction).toContain("Ask the user");
  });
});
