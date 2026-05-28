import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { failMock } = vi.hoisted(() => ({
  failMock: vi.fn((code: string, message: string) => {
    throw new Error(`${code}: ${message}`);
  }),
}));

vi.mock("../cli/output.js", () => ({ fail: failMock }));

describe("attention metadata parsing", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "first-tree-meta-"));
    failMock.mockClear();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("parses dotted paths, arrays, and scalar coercions", async () => {
    const { collectMeta, parseMetaFlags } = await import("../commands/attention/_shared/meta.js");
    const flags = [
      "subject=release",
      "requiresResponse=true",
      "count=3",
      "empty=",
      "options.items[0].label=Ship",
      "options.items[0].value=ship",
      "options.items[1].label=Hold",
      "options.items[1].value=hold",
      "options.threshold=null",
    ];

    expect(parseMetaFlags(flags)).toEqual({
      subject: "release",
      requiresResponse: true,
      count: 3,
      empty: "",
      options: {
        items: [
          { label: "Ship", value: "ship" },
          { label: "Hold", value: "hold" },
        ],
        threshold: null,
      },
    });
    expect(collectMeta("a=b", ["x=y"])).toEqual(["x=y", "a=b"]);
  });

  it("merges inline and file JSON over flat flags", async () => {
    const { mergeMetaJson, parseMetaFlags } = await import("../commands/attention/_shared/meta.js");
    const jsonPath = join(tmp, "meta.json");
    writeFileSync(jsonPath, JSON.stringify({ subject: "from-file", nested: { ok: true } }));

    expect(mergeMetaJson(parseMetaFlags(["subject=flat"]), '{"body":"inline"}')).toEqual({
      subject: "flat",
      body: "inline",
    });
    expect(mergeMetaJson(parseMetaFlags(["subject=flat"]), `@${jsonPath}`)).toEqual({
      subject: "from-file",
      nested: { ok: true },
    });
  });

  it("routes malformed metadata through the CLI failure helper", async () => {
    const { mergeMetaJson, parseMetaFlags } = await import("../commands/attention/_shared/meta.js");

    expect(() => parseMetaFlags(["missing-equals"])).toThrow(/INVALID_META/);
    expect(() => parseMetaFlags(["items[0].name=a", "items.name=b"])).toThrow(/INVALID_META_PATH/);
    expect(() => mergeMetaJson({}, "[1,2,3]")).toThrow(/META_JSON_NOT_OBJECT/);
    expect(() => mergeMetaJson({}, "{not json")).toThrow(/META_JSON_INVALID/);
    expect(() => mergeMetaJson({}, `@${join(tmp, "missing.json")}`)).toThrow(/META_JSON_READ_FAILED/);
  });
});
