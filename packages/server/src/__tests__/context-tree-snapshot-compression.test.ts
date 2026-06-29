import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestAdmin, useTestApp } from "./helpers.js";

const execFileAsync = promisify(execFile);

// Shared ref the mock factory reads at call time. The validated org-settings
// binding only accepts HTTPS/SSH repo URLs, so we cannot point an org at an
// on-disk tree through the public path. Instead we mock the snapshot service to
// delegate to its REAL implementation against a local checkout — exercising the
// real route + @fastify/compress wiring against a genuine, populated snapshot.
const treeRef = vi.hoisted(() => ({ path: "" }));

vi.mock("../services/context-tree-snapshot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/context-tree-snapshot.js")>();
  return {
    ...actual,
    getContextTreeSnapshot: (
      _binding: Parameters<typeof actual.getContextTreeSnapshot>[0],
      window: Parameters<typeof actual.getContextTreeSnapshot>[1],
      options: Parameters<typeof actual.getContextTreeSnapshot>[2],
    ) => actual.getContextTreeSnapshot({ repo: treeRef.path, branch: "main" }, window, options),
  };
});

const getApp = useTestApp();

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

function node(title: string, description: string): string {
  return `---
title: "${title}"
description: "${description}"
owners: ["alice", "bob"]
---

# ${title}

${description} ${"Context detail line. ".repeat(8)}
`;
}

// A small but multi-node tree whose snapshot JSON comfortably exceeds the 1 KB
// compression threshold, so compression actually engages (it is byte-gated).
beforeAll(async () => {
  treeRef.path = await mkdtemp(join(tmpdir(), "context-tree-compress-"));
  await git(treeRef.path, ["init", "--initial-branch=main"]);
  await git(treeRef.path, ["config", "user.name", "Compression Tester"]);
  await git(treeRef.path, ["config", "user.email", "compression-tester@example.com"]);
  await git(treeRef.path, ["config", "commit.gpgsign", "false"]);

  await writeFile(join(treeRef.path, "NODE.md"), node("Acme Context Tree", "Root of the Acme team context tree."));
  for (const domain of ["runtime", "platform", "billing", "identity"]) {
    const dir = join(treeRef.path, "domains", domain);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "NODE.md"),
      node(`${domain} domain`, `Decisions, constraints, and ownership for the ${domain} domain.`),
    );
  }
  await git(treeRef.path, ["add", "."]);
  await git(treeRef.path, ["commit", "-m", "seed context tree"]);
});

afterAll(async () => {
  await rm(treeRef.path, { recursive: true, force: true });
});

describe("context tree snapshot compression", () => {
  it("gzip-compresses the org snapshot response when the client accepts it", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${admin.organizationId}/context-tree/snapshot?window=7d`,
      headers: { authorization: `Bearer ${admin.accessToken}`, "accept-encoding": "gzip" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-encoding"]).toBe("gzip");
    // The decompressed body is still a valid, populated snapshot.
    const decoded = JSON.parse(gunzipSync(response.rawPayload).toString("utf-8"));
    expect(decoded.snapshotStatus).toBe("active");
    expect(decoded.nodes.length).toBeGreaterThan(1);
  });

  it("leaves the response uncompressed when the client does not accept encoding", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${admin.organizationId}/context-tree/snapshot?window=7d`,
      headers: { authorization: `Bearer ${admin.accessToken}`, "accept-encoding": "identity" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-encoding"]).toBeUndefined();
    expect(JSON.parse(response.payload).snapshotStatus).toBe("active");
  });
});
