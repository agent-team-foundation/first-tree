import { mkdir, mkdtemp, realpath, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AttachmentUploader } from "../runtime/doc-snapshots.js";
import { type BuildImageAttachmentsOptions, buildMessageImageSnapshots } from "../runtime/image-snapshots.js";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic

function fakeUploadId(seq: number): string {
  return `00000000-0000-4000-8000-${seq.toString(16).padStart(12, "0")}`;
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

function opts(uploader: AttachmentUploader): BuildImageAttachmentsOptions {
  return { uploader, orgId: ORG_ID };
}

describe("buildMessageImageSnapshots — capture + strip", () => {
  let root: string;

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "img-snap-")));
    await mkdir(join(root, "shots"), { recursive: true });
    await writeFile(join(root, "shots", "filter.png"), PNG);
    await writeFile(join(root, "diagram.webp"), PNG);
    await writeFile(join(root, "notes.txt"), Buffer.from("hi"));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("captures a relative markdown image and strips it from the caption", async () => {
    const { uploader, uploads } = stubUploader();
    const res = await buildMessageImageSnapshots(
      "看效果：\n\n![filter 效果图](shots/filter.png)\n\n就这样",
      root,
      opts(uploader),
    );

    expect(res.imageRefs).toHaveLength(1);
    expect(res.imageRefs[0]).toMatchObject({
      imageId: fakeUploadId(1),
      mimeType: "image/png",
      filename: "filter.png",
      size: PNG.byteLength,
    });
    expect(res.strippedText).toBe("看效果：\n\n就这样");
    expect(res.strippedText).not.toContain("![");
    expect(uploads[0]).toMatchObject({ mimeType: "image/png", filename: "filter.png", orgId: ORG_ID });
  });

  it("captures an absolute in-workspace path and maps .webp mime", async () => {
    const { uploader } = stubUploader();
    const res = await buildMessageImageSnapshots(`![d](${join(root, "diagram.webp")})`, root, opts(uploader));
    expect(res.imageRefs).toHaveLength(1);
    expect(res.imageRefs[0]?.mimeType).toBe("image/webp");
    expect(res.strippedText).toBe("");
  });

  it("keeps first-appearance order and de-dupes the same file", async () => {
    const { uploader, uploads } = stubUploader();
    const res = await buildMessageImageSnapshots(
      "![a](shots/filter.png) 和 ![b](diagram.webp) 再来 ![c](shots/filter.png)",
      root,
      opts(uploader),
    );
    expect(res.imageRefs.map((r) => r.filename)).toEqual(["filter.png", "diagram.webp"]);
    expect(uploads).toHaveLength(2); // same file uploaded once
  });

  it("ignores non-image extensions, http URLs, and escaped bangs", async () => {
    const { uploader, uploads } = stubUploader();
    const res = await buildMessageImageSnapshots(
      "![doc](notes.txt) ![remote](https://x.test/a.png) \\![lit](shots/filter.png)",
      root,
      opts(uploader),
    );
    expect(res.imageRefs).toHaveLength(0);
    expect(uploads).toHaveLength(0);
    expect(res.strippedText).toContain("notes.txt");
    expect(res.strippedText).toContain("https://x.test/a.png");
  });

  it("leaves an out-of-fence image untouched (cannot read it)", async () => {
    const { uploader } = stubUploader();
    const res = await buildMessageImageSnapshots("![x](/etc/hosts.png)", root, opts(uploader));
    expect(res.imageRefs).toHaveLength(0);
    expect(res.strippedText).toBe("![x](/etc/hosts.png)");
  });

  it("is a pure pass-through when there are no image mentions", async () => {
    const { uploader, uploads } = stubUploader();
    const res = await buildMessageImageSnapshots("just text, no pictures", root, opts(uploader));
    expect(res).toEqual({ imageRefs: [], strippedText: "just text, no pictures", skipped: 0 });
    expect(uploads).toHaveLength(0);
  });

  it("counts an upload failure as skipped and leaves the mention", async () => {
    const failing: AttachmentUploader = {
      async uploadAttachment() {
        throw new Error("boom");
      },
    };
    const res = await buildMessageImageSnapshots("![a](shots/filter.png)", root, opts(failing));
    expect(res.imageRefs).toHaveLength(0);
    expect(res.skipped).toBe(1);
    expect(res.strippedText).toBe("![a](shots/filter.png)");
  });

  it("handles a pathological `![![![…` body in linear time (ReDoS guard)", async () => {
    const { uploader } = stubUploader();
    // With an ambiguous regex this backtracks polynomially; the linear regex
    // returns immediately. The vitest per-test timeout is the guard.
    const res = await buildMessageImageSnapshots(`${"![".repeat(50000)}(x`, root, opts(uploader));
    expect(res.imageRefs).toHaveLength(0);
  });

  it("does NOT capture an image mention inside a fenced code block", async () => {
    const { uploader, uploads } = stubUploader();
    const body = ["说明：", "", "```md", "![x](diagram.webp)", "```"].join("\n");
    const res = await buildMessageImageSnapshots(body, root, opts(uploader));
    expect(res.imageRefs).toHaveLength(0);
    expect(uploads).toHaveLength(0);
    expect(res.strippedText).toBe(body); // fenced code sample preserved verbatim
  });

  it("honors backslash-escape parity on the leading bang", async () => {
    const { uploader } = stubUploader();
    // Odd run → the `!` is escaped → literal, not captured.
    const one = await buildMessageImageSnapshots("see \\![x](shots/filter.png)", root, opts(uploader));
    expect(one.imageRefs).toHaveLength(0);
    // Even run → the backslashes are literal, the image is LIVE → captured.
    const two = await buildMessageImageSnapshots("see \\\\![x](shots/filter.png)", root, opts(uploader));
    expect(two.imageRefs).toHaveLength(1);
    const three = await buildMessageImageSnapshots("see \\\\\\![x](shots/filter.png)", root, opts(uploader));
    expect(three.imageRefs).toHaveLength(0);
  });

  it("does NOT capture an image in a fenced block nested in a blockquote", async () => {
    const { uploader } = stubUploader();
    const body = ["> 看代码：", "> ```md", "> ![x](diagram.webp)", "> ```"].join("\n");
    const res = await buildMessageImageSnapshots(body, root, opts(uploader));
    expect(res.imageRefs).toHaveLength(0);
    expect(res.strippedText).toBe(body);
  });

  it("does NOT capture an image in a fenced block nested in a list item", async () => {
    const { uploader } = stubUploader();
    const body = ["- 步骤：", "  ```md", "  ![x](diagram.webp)", "  ```"].join("\n");
    const res = await buildMessageImageSnapshots(body, root, opts(uploader));
    expect(res.imageRefs).toHaveLength(0);
  });

  it("does NOT capture an image inside an indented code block", async () => {
    const { uploader } = stubUploader();
    const body = ["示例：", "", "    ![x](diagram.webp)"].join("\n");
    const res = await buildMessageImageSnapshots(body, root, opts(uploader));
    expect(res.imageRefs).toHaveLength(0);
  });

  it("DOES capture an image written inside inline code (inline is treated as live)", async () => {
    // Deliberate scope: only block code (fenced/indented) is excluded. An image
    // embed inside inline code is rare and treated as a live embed.
    const { uploader } = stubUploader();
    const res = await buildMessageImageSnapshots("示例 `![x](shots/filter.png)` 完", root, opts(uploader));
    expect(res.imageRefs).toHaveLength(1);
  });

  it("stays fast with many fenced blocks and skips a >1MB body (guard)", async () => {
    const { uploader } = stubUploader();
    // Many tiny fenced blocks + a real image — must not blow up (linear).
    const manyFences = `${"```\nx\n```\n\n".repeat(20000)}![img](shots/filter.png)`;
    const r1 = await buildMessageImageSnapshots(manyFences, root, opts(uploader));
    expect(r1.imageRefs).toHaveLength(1);
    // A body over the scan cap is sent verbatim (best-effort capture skipped).
    const huge = `${"x".repeat(1024 * 1024 + 1)}\n![img](shots/filter.png)`;
    const r2 = await buildMessageImageSnapshots(huge, root, opts(uploader));
    expect(r2.imageRefs).toHaveLength(0);
    expect(r2.strippedText).toBe(huge);
  });

  it("preserves blank lines inside an unrelated fenced block when stripping a later image", async () => {
    const { uploader } = stubUploader();
    const body = ["```txt", "line1", "", "", "line2", "```", "", "![img](shots/filter.png)"].join("\n");
    const res = await buildMessageImageSnapshots(body, root, opts(uploader));
    expect(res.imageRefs).toHaveLength(1);
    // The two blank lines INSIDE the fence survive byte-for-byte.
    expect(res.strippedText).toBe(["```txt", "line1", "", "", "line2", "```"].join("\n"));
  });

  it("respects a longer closing fence and an unclosed (EOF) fence", async () => {
    const { uploader } = stubUploader();
    // 3-backtick open closed by a 4-backtick line — CommonMark closes here.
    const longerClose = ["````", "![a](shots/filter.png)", "````"].join("\n");
    const r1 = await buildMessageImageSnapshots(longerClose, root, opts(uploader));
    expect(r1.imageRefs).toHaveLength(0);
    expect(r1.strippedText).toBe(longerClose);
    // Unclosed fence extends to end-of-input.
    const unclosed = ["```md", "![b](diagram.webp)"].join("\n");
    const r2 = await buildMessageImageSnapshots(unclosed, root, opts(uploader));
    expect(r2.imageRefs).toHaveLength(0);
    expect(r2.strippedText).toBe(unclosed);
  });

  it("skips an oversized file via stat, without reading its bytes", async () => {
    // Sparse 11MB file: stat.size is over the 10MB cap, but no bytes allocate.
    const big = join(root, "huge.png");
    await writeFile(big, Buffer.alloc(0));
    await truncate(big, 11 * 1024 * 1024);
    const { uploader, uploads } = stubUploader();
    const res = await buildMessageImageSnapshots("![big](huge.png) 和 ![ok](shots/filter.png)", root, opts(uploader));
    expect(res.imageRefs.map((r) => r.filename)).toEqual(["filter.png"]); // only the small one
    expect(res.skipped).toBe(1);
    expect(uploads.map((u) => u.filename)).toEqual(["filter.png"]);
  });

  it("captures an image with a markdown title and strips the whole span", async () => {
    const { uploader } = stubUploader();
    const res = await buildMessageImageSnapshots('a ![s](shots/filter.png "标题") b', root, opts(uploader));
    expect(res.imageRefs).toHaveLength(1);
    expect(res.strippedText).toBe("a  b");
  });

  it("de-dupes strip both occurrences of the same image", async () => {
    const { uploader } = stubUploader();
    const res = await buildMessageImageSnapshots(
      "![a](shots/filter.png) x ![b](shots/filter.png)",
      root,
      opts(uploader),
    );
    expect(res.imageRefs).toHaveLength(1);
    expect(res.strippedText).not.toContain("![");
    expect(res.strippedText).toBe("x");
  });

  it("in a mixed-success message, strips even the failed image's span (no broken <img> in the flipped caption)", async () => {
    // Uploader fails only for the .webp so one image captures and one does not.
    const uploads: string[] = [];
    let seq = 0;
    const selective: AttachmentUploader = {
      async uploadAttachment(o) {
        if (o.filename.endsWith(".webp")) throw new Error("nope");
        seq += 1;
        uploads.push(o.filename);
        return { id: fakeUploadId(seq), mimeType: o.mimeType, filename: o.filename, sizeBytes: 8 };
      },
    };
    const res = await buildMessageImageSnapshots(
      "![ok](shots/filter.png) 和 ![bad](diagram.webp)",
      root,
      opts(selective),
    );
    expect(res.imageRefs.map((r) => r.filename)).toEqual(["filter.png"]);
    expect(res.skipped).toBe(1);
    expect(res.strippedText).not.toContain("!["); // both spans stripped, no broken mention
  });
});

describe("buildMessageImageSnapshots — batch cap", () => {
  let root: string;

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "img-cap-")));
    for (let i = 0; i < 25; i += 1) await writeFile(join(root, `p${i}.png`), PNG);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("caps resolution+upload at MAX_BATCH_ATTACHMENTS (20) before the fan-out", async () => {
    const { uploader, uploads } = stubUploader();
    const body = Array.from({ length: 25 }, (_, i) => `![p${i}](p${i}.png)`).join(" ");
    const res = await buildMessageImageSnapshots(body, root, opts(uploader));
    expect(res.imageRefs).toHaveLength(20);
    expect(res.skipped).toBe(5);
    // Only 20 distinct paths were resolved+uploaded — the fs fan-out is bounded
    // by the cap, not by the number of syntactic occurrences.
    expect(uploads).toHaveLength(20);
    // Every candidate span is stripped from the flipped caption — the 5 over-cap
    // mentions are dropped, NOT left as broken local paths.
    expect(res.strippedText).not.toContain("![");
  });

  it("strips an over-cap and an out-of-fence mention from a flipped caption (no broken paths)", async () => {
    const { uploader } = stubUploader();
    // 20 in-cap workspace images fill the batch; one out-of-fence path is over
    // and beyond the fence — both must be removed from the file-batch caption.
    const inCap = Array.from({ length: 20 }, (_, i) => `![p${i}](p${i}.png)`).join(" ");
    const res = await buildMessageImageSnapshots(`${inCap} ![x](/etc/hosts.png)`, root, opts(uploader));
    expect(res.imageRefs).toHaveLength(20);
    expect(res.strippedText).not.toContain("!["); // out-of-fence one also stripped
    expect(res.strippedText).not.toContain("/etc/hosts.png");
  });
});
