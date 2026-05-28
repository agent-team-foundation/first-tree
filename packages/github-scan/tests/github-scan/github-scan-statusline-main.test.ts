import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FakeFsState = {
  exists: boolean;
  inboxRaw: string;
  bellRaw: string | null;
  mtimeMs: number;
  statThrows: boolean;
  writeThrows: boolean;
  writes: string[];
};

async function loadStatuslineWithFs(state: FakeFsState) {
  vi.doMock("node:fs", () => ({
    existsSync: vi.fn(() => state.exists),
    readFileSync: vi.fn((path: string | number) => {
      if (path === 0) return Buffer.from("{}");
      if (typeof path === "string" && path.endsWith(".bell_state")) {
        if (state.bellRaw === null) throw new Error("missing bell state");
        return state.bellRaw;
      }
      return state.inboxRaw;
    }),
    statSync: vi.fn(() => {
      if (state.statThrows) throw new Error("stat failed");
      return { mtimeMs: state.mtimeMs };
    }),
    writeFileSync: vi.fn((_path: string, value: string) => {
      if (state.writeThrows) throw new Error("write failed");
      state.writes.push(value);
    }),
  }));
  return import("../../src/github-scan/engine/statusline.js");
}

function createState(overrides: Partial<FakeFsState> = {}): FakeFsState {
  return {
    exists: true,
    inboxRaw: JSON.stringify({
      last_poll: "2026-05-28T00:00:00Z",
      notifications: [
        { github_scan_status: "new", type: "PullRequest" },
        { github_scan_status: "new", type: "Issue" },
        { github_scan_status: "human", type: "PullRequest" },
        { github_scan_status: "done", type: "Discussion" },
      ],
    }),
    bellRaw: "2026-05-27T00:00:00Z 0 0\n",
    mtimeMs: 2_000_000,
    statThrows: false,
    writeThrows: false,
    writes: [],
    ...overrides,
  };
}

describe("statusline main filesystem paths", () => {
  let originalStdoutWrite: typeof process.stdout.write;
  let stdout = "";

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.GITHUB_SCAN_DIR = "/tmp/github-scan-test";
    stdout = "";
    originalStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      stdout += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = originalStdoutWrite;
    delete process.env.GITHUB_SCAN_DIR;
    vi.restoreAllMocks();
  });

  it("does nothing when the inbox is absent, unreadable, or invalid", async () => {
    const missing = await loadStatuslineWithFs(createState({ exists: false }));
    expect(missing.main(2_000)).toBe(0);
    expect(stdout).toBe("");

    vi.resetModules();
    stdout = "";
    const invalid = await loadStatuslineWithFs(createState({ inboxRaw: "{not json" }));
    expect(invalid.main(2_000)).toBe(0);
    expect(stdout).toBe("");

    vi.resetModules();
    stdout = "";
    const empty = await loadStatuslineWithFs(createState({ inboxRaw: "" }));
    expect(empty.main(2_000)).toBe(0);
    expect(stdout).toBe("");
  });

  it("prints stale status when the inbox mtime is too old and ignores stat races", async () => {
    const stale = await loadStatuslineWithFs(createState({ mtimeMs: 1_000 }));
    expect(stale.main(2_000)).toBe(0);
    expect(stdout).toBe("/github-scan: stale (poller not running?)\n");

    vi.resetModules();
    stdout = "";
    const statRace = await loadStatuslineWithFs(createState({ statThrows: true }));
    expect(statRace.main(2_000)).toBe(0);
    expect(stdout).toBe("");
  });

  it("renders counts, rings on increases, and persists bell state best-effort", async () => {
    const state = createState({ writeThrows: true });
    const statusline = await loadStatuslineWithFs(state);

    expect(statusline.main(2_000)).toBe(0);

    expect(stdout).toBe("\u0007/github-scan: ⚠ 1 need-you · 1 PRs · 1 issues (+1 need-you)\n");
    expect(state.writes).toEqual([]);

    vi.resetModules();
    stdout = "";
    const writable = createState({ bellRaw: "2026-05-28T00:00:00Z 2 1\n" });
    const statuslineWritable = await loadStatuslineWithFs(writable);
    expect(statuslineWritable.main(2_000)).toBe(0);
    expect(stdout).toBe("/github-scan: ⚠ 1 need-you · 1 PRs · 1 issues\n");
    expect(writable.writes).toEqual(["2026-05-28T00:00:00Z 2 1\n"]);
  });
});
