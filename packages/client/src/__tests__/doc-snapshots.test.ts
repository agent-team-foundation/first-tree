import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AttachmentUploader,
  type BuildDocAttachmentsOptions,
  buildMessageDocumentSnapshots,
} from "../runtime/doc-snapshots.js";

/**
 * Unit tests for the runtime doc-capture builder after the attachment-ref
 * convergence. A resolved `.md` reference is now uploaded to the org blob store
 * and rewritten into an explicit `[display](attachment:<id>)` link; the bytes
 * are no longer inlined. We use a deterministic stub uploader that mints
 * uuid-shaped ids so the rewrite output is assertable.
 */

const ORG_ID = "11111111-1111-4111-8111-111111111111";

function fakeUploadId(seq: number): string {
  const hex = seq.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
}

type RecordedUpload = { bytes: Buffer; mimeType: string; filename: string; orgId: string };

function stubUploader(): { uploader: AttachmentUploader; uploads: RecordedUpload[] } {
  const uploads: RecordedUpload[] = [];
  let seq = 0;
  const uploader: AttachmentUploader = {
    async uploadAttachment(opts) {
      seq += 1;
      const bytes = Buffer.from(opts.bytes);
      uploads.push({ bytes, mimeType: opts.mimeType, filename: opts.filename, orgId: opts.orgId });
      return { id: fakeUploadId(seq), mimeType: opts.mimeType, filename: opts.filename, sizeBytes: bytes.byteLength };
    },
  };
  return { uploader, uploads };
}

function failingUploader(): AttachmentUploader {
  return {
    async uploadAttachment() {
      throw new Error("upload boom");
    },
  };
}

function opts(uploader: AttachmentUploader): BuildDocAttachmentsOptions {
  return { uploader, orgId: ORG_ID };
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

describe("buildMessageDocumentSnapshots — capture + attachment-link rewrite", () => {
  let root: string;
  let outside: string;
  let uploads: RecordedUpload[];
  let uploader: AttachmentUploader;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "doc-snap-root-"));
    await writeFile(join(root, "design.md"), "# design\n", "utf8");
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "intro.md"), "# intro\n", "utf8");
    await mkdir(join(root, ".agent"), { recursive: true });
    await writeFile(join(root, ".agent", "secret.md"), "# secret\n", "utf8");
    await symlink(join(root, ".agent", "secret.md"), join(root, "public.md"));

    outside = await mkdtemp(join(tmpdir(), "doc-snap-outside-"));
    await writeFile(join(outside, "external.md"), "# external\n", "utf8");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  beforeEach(() => {
    const stub = stubUploader();
    uploader = stub.uploader;
    uploads = stub.uploads;
  });

  it("uploads a bare absolute-in-root token and rewrites it to an attachment link", async () => {
    const abs = join(root, "design.md");
    const { refs, rewrittenText } = await buildMessageDocumentSnapshots(`wrote ${abs} just now`, root, opts(uploader));

    expect(refs).toHaveLength(1);
    expect(refs[0]?.kind).toBe("document");
    expect(refs[0]?.source?.path).toBe("design.md");
    expect(refs[0]?.mimeType).toBe("text/markdown");
    expect(refs[0]?.sha256).toBe(sha256("# design\n"));
    expect(refs[0]?.filename).toBe("design.md");
    expect(rewrittenText).toBe(`wrote [design.md](attachment:${fakeUploadId(1)}) just now`);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.orgId).toBe(ORG_ID);
  });

  it("retargets an inline markdown link's target at the attachment", async () => {
    const abs = join(root, "docs", "intro.md");
    const { refs, rewrittenText } = await buildMessageDocumentSnapshots(
      `see [intro](${abs}) for setup`,
      root,
      opts(uploader),
    );
    expect(refs[0]?.source?.path).toBe("docs/intro.md");
    expect(rewrittenText).toBe(`see [intro](attachment:${fakeUploadId(1)}) for setup`);
  });

  it("keeps the :line[:col] suffix on the display, points href at the attachment", async () => {
    const abs = join(root, "docs", "intro.md");
    const { refs, rewrittenText } = await buildMessageDocumentSnapshots(`open ${abs}:42:7 here`, root, opts(uploader));
    expect(refs[0]?.source?.path).toBe("docs/intro.md");
    expect(rewrittenText).toBe(`open [docs/intro.md:42:7](attachment:${fakeUploadId(1)}) here`);
  });

  it("leaves an out-of-root absolute path untouched — no upload, no rewrite", async () => {
    const abs = join(outside, "external.md");
    const text = `external doc at ${abs} here`;
    const { refs, rewrittenText } = await buildMessageDocumentSnapshots(text, root, opts(uploader));
    expect(refs).toEqual([]);
    expect(rewrittenText).toBe(text);
    expect(uploads).toEqual([]);
  });

  it("links a bare relative mention; dedupes the same file mentioned twice to one upload", async () => {
    const { refs, rewrittenText } = await buildMessageDocumentSnapshots(
      "see docs/intro.md and again docs/intro.md",
      root,
      opts(uploader),
    );
    expect(refs).toHaveLength(1);
    expect(uploads).toHaveLength(1);
    expect(rewrittenText).toBe(
      `see [docs/intro.md](attachment:${fakeUploadId(1)}) and again [docs/intro.md](attachment:${fakeUploadId(1)})`,
    );
  });

  it("rejects a symlink whose realpath crosses into a hidden dir (relative + absolute)", async () => {
    const relOut = await buildMessageDocumentSnapshots("see [p](public.md)", root, opts(uploader));
    expect(relOut.refs).toEqual([]);
    const abs = join(root, "public.md");
    const absOut = await buildMessageDocumentSnapshots(`see ${abs}`, root, opts(uploader));
    expect(absOut.refs).toEqual([]);
  });

  it("reports a bare missing mention as a failedMention and leaves it plain text", async () => {
    const { refs, failedMentions, rewrittenText } = await buildMessageDocumentSnapshots(
      "read directory-or-missing.md",
      root,
      opts(uploader),
    );
    expect(refs).toEqual([]);
    expect(failedMentions).toEqual([{ raw: "directory-or-missing.md", reason: "missing" }]);
    expect(rewrittenText).toBe("read directory-or-missing.md");
  });

  it("degrades to plain text (no rewrite) when the upload fails after retries", async () => {
    const { refs, failedMentions, rewrittenText } = await buildMessageDocumentSnapshots(
      "see design.md please",
      root,
      opts(failingUploader()),
    );
    expect(refs).toEqual([]);
    expect(rewrittenText).toBe("see design.md please");
    // A bare mention whose upload failed surfaces an inert-chip reason.
    expect(failedMentions).toEqual([{ raw: "design.md", reason: "unreadable" }]);
  });

  it("does not capture when no .md mention is present", async () => {
    const { refs, rewrittenText } = await buildMessageDocumentSnapshots("just chatting", root, opts(uploader));
    expect(refs).toEqual([]);
    expect(rewrittenText).toBe("just chatting");
    expect(uploads).toEqual([]);
  });

  // R4: the capture cap was raised from 256KB to the 10MB upload cap. A doc
  // larger than the OLD 256KB ceiling but well under the upload cap must now be
  // captured (it used to fail `too-large`). Would fail before the fix.
  it("captures a doc larger than the legacy 256KB cap (capture cap = upload cap)", async () => {
    const big = `# big\n${"x".repeat(400 * 1024)}\n`;
    await writeFile(join(root, "big.md"), big, "utf8");
    const { refs, failedMentions } = await buildMessageDocumentSnapshots("see big.md", root, opts(uploader));
    expect(refs).toHaveLength(1);
    expect(refs[0]?.source?.path).toBe("big.md");
    expect(failedMentions).toEqual([]);
    expect(uploads).toHaveLength(1);
  });

  // R4: a doc above the 10MB upload cap still degrades to `too-large` (the blob
  // store would reject the upload anyway), so the new ceiling is the upload cap.
  it("fails a doc above the 10MB upload cap as too-large", async () => {
    const huge = `# huge\n${"y".repeat(11 * 1024 * 1024)}\n`;
    await writeFile(join(root, "huge.md"), huge, "utf8");
    const { refs, failedMentions, rewrittenText } = await buildMessageDocumentSnapshots(
      "see huge.md",
      root,
      opts(uploader),
    );
    expect(refs).toEqual([]);
    expect(failedMentions).toEqual([{ raw: "huge.md", reason: "too-large" }]);
    expect(rewrittenText).toBe("see huge.md");
    expect(uploads).toEqual([]);
  });
});

describe("buildMessageDocumentSnapshots — cross-agent workspace fence", () => {
  let workspacesRoot: string;
  let selfRoot: string;
  let crossRoot: string;
  const CHAT = "22222222-2222-4222-8222-222222222222";

  beforeAll(async () => {
    workspacesRoot = await mkdtemp(join(tmpdir(), "doc-snap-ws-"));
    selfRoot = join(workspacesRoot, "coder", CHAT);
    crossRoot = join(workspacesRoot, "assistant", CHAT);
    await mkdir(selfRoot, { recursive: true });
    await mkdir(crossRoot, { recursive: true });
    await writeFile(join(crossRoot, "plan.md"), "# their plan\n", "utf8");
  });

  afterAll(async () => {
    await rm(workspacesRoot, { recursive: true, force: true });
  });

  function fence() {
    return { workspacesRoot, chatId: CHAT, selfSlug: "coder" };
  }

  it("captures a cross-agent doc under the shared root and uses the short source path", async () => {
    const stub = stubUploader();
    const abs = join(crossRoot, "plan.md");
    const { refs, rewrittenText } = await buildMessageDocumentSnapshots(
      `see ${abs} please`,
      selfRoot,
      opts(stub.uploader),
      fence(),
    );
    expect(refs).toHaveLength(1);
    expect(refs[0]?.source?.path).toBe("assistant/plan.md");
    expect(rewrittenText).toBe(`see [assistant/plan.md](attachment:${fakeUploadId(1)}) please`);
  });

  it("does not capture a cross-agent doc when no fence is supplied", async () => {
    const stub = stubUploader();
    const abs = join(crossRoot, "plan.md");
    const { refs } = await buildMessageDocumentSnapshots(`see ${abs}`, selfRoot, opts(stub.uploader));
    expect(refs).toEqual([]);
  });
});

describe("buildMessageDocumentSnapshots — orgId plumbing", () => {
  it("passes the orgId through to every upload", async () => {
    const root = await mkdtemp(join(tmpdir(), "doc-snap-org-"));
    try {
      await writeFile(join(root, "a.md"), "# a\n", "utf8");
      const realRoot = await realpath(root);
      const stub = stubUploader();
      await buildMessageDocumentSnapshots("see a.md", realRoot, { uploader: stub.uploader, orgId: "org-xyz" });
      expect(stub.uploads.map((u) => u.orgId)).toEqual(["org-xyz"]);
      // Spies stay quiet — no global mocks here.
      vi.clearAllMocks();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
