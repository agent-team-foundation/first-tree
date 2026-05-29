import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const exitMock = vi.spyOn(process, "exit").mockImplementation((() => {
  throw new Error("process.exit");
}) as never);
const stderrMock = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "ft-attention-meta-"));
  exitMock.mockClear();
  stderrMock.mockClear();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("attention metadata helpers", () => {
  it("parses dotted paths, array indexes, and scalar values", async () => {
    const { parseMetaFlags } = await import("../commands/attention/_shared/meta.js");

    expect(
      parseMetaFlags([
        "subject=deploy",
        "options.mode=single",
        "options.items[0].label=Ship now",
        "options.items[0].value=now",
        "options.items[1].label=Wait",
        "requiresResponse=true",
        "priority=3",
        "ratio=-1.5",
        "empty=",
        "nullable=null",
      ]),
    ).toEqual({
      subject: "deploy",
      options: {
        mode: "single",
        items: [{ label: "Ship now", value: "now" }, { label: "Wait" }],
      },
      requiresResponse: true,
      priority: 3,
      ratio: -1.5,
      empty: "",
      nullable: null,
    });
  });

  it("merges inline and file JSON over flat metadata", async () => {
    const { mergeMetaJson, parseMetaFlags } = await import("../commands/attention/_shared/meta.js");
    const file = join(tempDir, "meta.json");
    writeFileSync(file, JSON.stringify({ priority: "high", nested: { source: "file" } }));

    expect(mergeMetaJson(parseMetaFlags(["priority=1", "subject=deploy"]), '{"priority":2}')).toEqual({
      priority: 2,
      subject: "deploy",
    });
    expect(mergeMetaJson({ subject: "deploy" }, `@${file}`)).toEqual({
      subject: "deploy",
      priority: "high",
      nested: { source: "file" },
    });
  });

  it("collects repeated metadata flags", async () => {
    const { collectMeta } = await import("../commands/attention/_shared/meta.js");

    expect(collectMeta("b=2", collectMeta("a=1", []))).toEqual(["a=1", "b=2"]);
  });

  it("fails on malformed flat metadata and malformed JSON", async () => {
    const { mergeMetaJson, parseMetaFlags } = await import("../commands/attention/_shared/meta.js");

    expect(() => parseMetaFlags(["bad"])).toThrow("process.exit");
    expect(() => parseMetaFlags(["a..b=1"])).toThrow("process.exit");
    expect(() => parseMetaFlags(["items[0].name=ok", "items.name=bad"])).toThrow("process.exit");
    expect(() => mergeMetaJson({}, "{bad json")).toThrow("process.exit");
    expect(() => mergeMetaJson({}, "[]")).toThrow("process.exit");
    expect(exitMock).toHaveBeenCalledWith(2);
  });
});
