import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttachmentUploader, BuildDocAttachmentsOptions } from "../runtime/doc-snapshots.js";

const ORG_ID = "11111111-1111-4111-8111-111111111111";

function noopUploader(): BuildDocAttachmentsOptions {
  let seq = 0;
  const uploader: AttachmentUploader = {
    async uploadAttachment(o) {
      seq += 1;
      const bytes = Buffer.from(o.bytes);
      return {
        id: `00000000-0000-4000-8000-${seq.toString(16).padStart(12, "0")}`,
        mimeType: o.mimeType,
        filename: o.filename,
        sizeBytes: bytes.byteLength,
      };
    },
  };
  return { uploader, orgId: ORG_ID };
}

describe("buildMessageDocumentSnapshots — filesystem failure edges", () => {
  afterEach(() => {
    vi.doUnmock("node:fs/promises");
    vi.resetModules();
  });

  it("reports a read failure as unreadable", async () => {
    const root = await mkdtemp(join(tmpdir(), "doc-snap-read-fail-"));
    const target = join(root, "unreadable.md");
    await writeFile(target, "# unreadable\n", "utf8");
    const targetReal = await realpath(target);

    vi.resetModules();
    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      return {
        ...actual,
        readFile: (path: string) => {
          if (path === targetReal) throw new Error("blocked read");
          return actual.readFile(path);
        },
      };
    });

    try {
      const { buildMessageDocumentSnapshots } = await import("../runtime/doc-snapshots.js");
      const { refs, failedMentions, skipped } = await buildMessageDocumentSnapshots(
        "see unreadable.md",
        root,
        noopUploader(),
      );

      expect(refs).toEqual([]);
      expect(skipped).toBe(1);
      expect(failedMentions).toEqual([{ raw: "unreadable.md", reason: "unreadable" }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats a self stat failure during resolution as missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "doc-snap-stat-fail-"));
    const target = join(root, "stat-fail.md");
    await writeFile(target, "# stat fail\n", "utf8");
    const targetReal = await realpath(target);

    vi.resetModules();
    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      return {
        ...actual,
        stat: (path: string) => {
          if (path === targetReal) throw new Error("blocked stat");
          return actual.stat(path);
        },
      };
    });

    try {
      const { buildMessageDocumentSnapshots } = await import("../runtime/doc-snapshots.js");
      const { refs, failedMentions } = await buildMessageDocumentSnapshots("see stat-fail.md", root, noopUploader());

      expect(refs).toEqual([]);
      expect(failedMentions).toEqual([{ raw: "stat-fail.md", reason: "missing" }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
