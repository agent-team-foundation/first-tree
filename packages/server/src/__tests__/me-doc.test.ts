import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ForbiddenError, NotFoundError } from "../errors.js";
import { getMeDocPreview } from "../services/me-doc.js";

const baseInput = {
  chatId: "chat-1",
  agentId: "agent-1",
  agentName: "coder",
};

async function makeWorkspace(): Promise<{ workspacesRoot: string; workspaceRoot: string }> {
  const workspacesRoot = await mkdtemp(join(tmpdir(), "first-tree-hub-workspaces-"));
  const workspaceRoot = join(workspacesRoot, baseInput.agentName, baseInput.chatId);
  await mkdir(workspaceRoot, { recursive: true });
  return { workspacesRoot, workspaceRoot };
}

describe("getMeDocPreview", () => {
  it("reads markdown files under an agent chat workspace", async () => {
    const { workspacesRoot, workspaceRoot } = await makeWorkspace();
    await writeFile(join(workspaceRoot, "guide.md"), "# Guide\n\nHello.", "utf8");

    await expect(getMeDocPreview({ ...baseInput, path: "guide.md", workspacesRoot })).resolves.toEqual({
      ref: { type: "workspace", chatId: "chat-1", agentId: "agent-1", path: "guide.md" },
      path: "guide.md",
      content: "# Guide\n\nHello.",
    });
  });

  it("supports an optional base path inside the workspace", async () => {
    const { workspacesRoot, workspaceRoot } = await makeWorkspace();
    await mkdir(join(workspaceRoot, "first-tree-hub", "docs"), { recursive: true });
    await writeFile(join(workspaceRoot, "first-tree-hub", "docs", "design.md"), "# Design", "utf8");

    await expect(
      getMeDocPreview({ ...baseInput, basePath: "first-tree-hub", path: "docs/design.md", workspacesRoot }),
    ).resolves.toMatchObject({
      ref: {
        type: "workspace",
        chatId: "chat-1",
        agentId: "agent-1",
        basePath: "first-tree-hub",
        path: "docs/design.md",
      },
      path: "first-tree-hub/docs/design.md",
      content: "# Design",
    });
  });

  it("rejects paths that escape the workspace", async () => {
    const { workspacesRoot, workspaceRoot } = await makeWorkspace();
    await writeFile(join(workspaceRoot, "inside.md"), "inside", "utf8");

    await expect(getMeDocPreview({ ...baseInput, path: "../package.md", workspacesRoot })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("rejects non-markdown files", async () => {
    const { workspacesRoot, workspaceRoot } = await makeWorkspace();
    await writeFile(join(workspaceRoot, "notes.txt"), "notes", "utf8");

    await expect(getMeDocPreview({ ...baseInput, path: "notes.txt", workspacesRoot })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("rejects symlinks that escape the workspace", async () => {
    const { workspacesRoot, workspaceRoot } = await makeWorkspace();
    const outside = join(workspacesRoot, "outside.md");
    await writeFile(outside, "outside", "utf8");
    await symlink(outside, join(workspaceRoot, "linked.md"));

    await expect(getMeDocPreview({ ...baseInput, path: "linked.md", workspacesRoot })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("rejects documents above the preview size limit", async () => {
    const { workspacesRoot, workspaceRoot } = await makeWorkspace();
    await writeFile(join(workspaceRoot, "large.md"), "x".repeat(5 * 1024 * 1024 + 1), "utf8");

    await expect(getMeDocPreview({ ...baseInput, path: "large.md", workspacesRoot })).rejects.toMatchObject({
      statusCode: 413,
    });
  });

  it("returns not found for missing markdown files", async () => {
    const { workspacesRoot } = await makeWorkspace();

    await expect(getMeDocPreview({ ...baseInput, path: "missing.md", workspacesRoot })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
