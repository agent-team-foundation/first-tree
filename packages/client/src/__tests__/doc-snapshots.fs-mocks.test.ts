import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("buildMessageDocumentSnapshots — filesystem failure edges", () => {
  afterEach(() => {
    vi.doUnmock("@first-tree/shared");
    vi.doUnmock("node:fs/promises");
    vi.doUnmock("node:path");
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
      const { docs, failedMentions, skipped } = await buildMessageDocumentSnapshots("see unreadable.md", root);

      expect(docs).toEqual([]);
      expect(skipped).toBe(1);
      expect(failedMentions).toEqual([{ raw: "unreadable.md", reason: "unreadable" }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats a self stat failure during read-time resolution as missing", async () => {
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
      const { docs, failedMentions, skipped } = await buildMessageDocumentSnapshots("see stat-fail.md", root);

      expect(docs).toEqual([]);
      expect(skipped).toBe(1);
      expect(failedMentions).toEqual([{ raw: "stat-fail.md", reason: "missing" }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("classifies cross-workspace stat failures as missing", async () => {
    const workspacesRoot = await mkdtemp(join(tmpdir(), "doc-snap-cross-stat-"));
    const chatId = "chat-stat";
    const selfSlug = "coder";
    const selfRoot = join(workspacesRoot, selfSlug, chatId);
    const target = join(workspacesRoot, "assistant", chatId, "cross-stat.md");
    await mkdir(selfRoot, { recursive: true });
    await mkdir(join(workspacesRoot, "assistant", chatId), { recursive: true });
    await writeFile(target, "# cross stat\n", "utf8");
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
      const { docs, failedMentions } = await buildMessageDocumentSnapshots(`see ${target}`, selfRoot, {
        workspacesRoot,
        chatId,
        selfSlug,
      });

      expect(docs).toEqual([]);
      expect(failedMentions).toEqual([{ raw: target, reason: "missing" }]);
    } finally {
      await rm(workspacesRoot, { recursive: true, force: true });
    }
  });

  it("classifies inside-home stat failures after canonical-key rejection as missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "doc-snap-classify-stat-"));
    const target = join(root, "query?segment", "note.md");
    await mkdir(join(root, "query?segment"), { recursive: true });
    await writeFile(target, "# query segment\n", "utf8");
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
      const { docs, failedMentions } = await buildMessageDocumentSnapshots(`see [note](${target})`, root);

      expect(docs).toEqual([]);
      expect(failedMentions).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("marks a normalized key that does not end in .md as missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "doc-snap-normalize-non-md-"));
    await writeFile(join(root, "design.md"), "# design\n", "utf8");

    vi.resetModules();
    vi.doMock("@first-tree/shared", async () => {
      const actual = await vi.importActual<typeof import("@first-tree/shared")>("@first-tree/shared");
      return {
        ...actual,
        normalizeDocLinkPath: (raw: string) => {
          if (raw === "design.md") return "design.txt";
          return actual.normalizeDocLinkPath(raw);
        },
      };
    });

    try {
      const { buildMessageDocumentSnapshots } = await import("../runtime/doc-snapshots.js");
      const { docs, failedMentions } = await buildMessageDocumentSnapshots("see design.md", root);

      expect(docs).toEqual([]);
      expect(failedMentions).toEqual([{ raw: "design.md", reason: "missing" }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats an absolute normalized key as missing at read-time resolution", async () => {
    const root = await mkdtemp(join(tmpdir(), "doc-snap-normalize-abs-"));

    vi.resetModules();
    vi.doMock("@first-tree/shared", async () => {
      const actual = await vi.importActual<typeof import("@first-tree/shared")>("@first-tree/shared");
      return {
        ...actual,
        normalizeDocLinkPath: (raw: string) => {
          if (raw === "absolute-key.md") return "/absolute-key.md";
          return actual.normalizeDocLinkPath(raw);
        },
      };
    });

    try {
      const { buildMessageDocumentSnapshots } = await import("../runtime/doc-snapshots.js");
      const { docs, failedMentions } = await buildMessageDocumentSnapshots("see absolute-key.md", root);

      expect(docs).toEqual([]);
      expect(failedMentions).toEqual([{ raw: "absolute-key.md", reason: "missing" }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("drops a read-time path that starts resolving outside the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "doc-snap-toctou-outside-"));
    const outside = await mkdtemp(join(tmpdir(), "doc-snap-toctou-outside-target-"));
    const target = join(root, "flip.md");
    const outsideTarget = join(outside, "external.md");
    await writeFile(target, "# flip\n", "utf8");
    await writeFile(outsideTarget, "# external\n", "utf8");
    const outsideReal = await realpath(outsideTarget);
    let targetRealpathCalls = 0;

    vi.resetModules();
    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      return {
        ...actual,
        realpath: async (path: string) => {
          if (path === target) {
            targetRealpathCalls += 1;
            if (targetRealpathCalls === 2) return outsideReal;
          }
          return actual.realpath(path);
        },
      };
    });

    try {
      const { buildMessageDocumentSnapshots } = await import("../runtime/doc-snapshots.js");
      const { docs, failedMentions } = await buildMessageDocumentSnapshots("see flip.md", root);

      expect(docs).toEqual([]);
      expect(failedMentions).toEqual([{ raw: "flip.md", reason: "missing" }]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("drops a read-time path that starts resolving into a hidden segment", async () => {
    const root = await mkdtemp(join(tmpdir(), "doc-snap-toctou-hidden-"));
    const target = join(root, "flip-hidden.md");
    const hiddenTarget = join(root, ".agent", "secret.md");
    await mkdir(join(root, ".agent"), { recursive: true });
    await writeFile(target, "# flip\n", "utf8");
    await writeFile(hiddenTarget, "# secret\n", "utf8");
    const hiddenReal = await realpath(hiddenTarget);
    let targetRealpathCalls = 0;

    vi.resetModules();
    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      return {
        ...actual,
        realpath: async (path: string) => {
          if (path === target) {
            targetRealpathCalls += 1;
            if (targetRealpathCalls === 2) return hiddenReal;
          }
          return actual.realpath(path);
        },
      };
    });

    try {
      const { buildMessageDocumentSnapshots } = await import("../runtime/doc-snapshots.js");
      const { docs, failedMentions } = await buildMessageDocumentSnapshots("see flip-hidden.md", root);

      expect(docs).toEqual([]);
      expect(failedMentions).toEqual([{ raw: "flip-hidden.md", reason: "missing" }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("classifies a cross hidden segment after the home-relative hidden check clears", async () => {
    const workspacesRoot = await mkdtemp(join(tmpdir(), "doc-snap-path-hidden-ws-"));
    const home = await mkdtemp(join(tmpdir(), "doc-snap-path-hidden-home-"));
    const chatId = "chat-path";
    const target = join(workspacesRoot, "assistant", chatId, "notes.md");
    await mkdir(join(workspacesRoot, "assistant", chatId), { recursive: true });
    await writeFile(target, "# path mock\n", "utf8");
    const workspacesRootReal = await realpath(workspacesRoot);
    const homeReal = await realpath(home);
    const targetReal = await realpath(target);

    vi.resetModules();
    vi.doMock("node:path", async () => {
      const actual = await vi.importActual<typeof import("node:path")>("node:path");
      return {
        ...actual,
        relative: (from: string, to: string) => {
          if (from === homeReal && to === targetReal) return "safe/notes.md";
          if (from === workspacesRootReal && to === targetReal) return `assistant/${chatId}/.hidden/notes.md`;
          return actual.relative(from, to);
        },
      };
    });

    try {
      const { buildMessageDocumentSnapshots } = await import("../runtime/doc-snapshots.js");
      const { docs, failedMentions } = await buildMessageDocumentSnapshots(`see ${target}`, home, {
        workspacesRoot,
        chatId,
        selfSlug: "coder",
      });

      expect(docs).toEqual([]);
      expect(failedMentions).toEqual([{ raw: target, reason: "hidden-segment" }]);
    } finally {
      await rm(workspacesRoot, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it("drops a cross path whose relative owner segment is empty", async () => {
    const nativeFilter = Array.prototype.filter;
    const workspacesRoot = await mkdtemp(join(tmpdir(), "doc-snap-empty-owner-ws-"));
    const home = await mkdtemp(join(tmpdir(), "doc-snap-empty-owner-home-"));
    const chatId = "chat-empty";
    const target = join(workspacesRoot, "assistant", chatId, "file.md");
    await mkdir(join(workspacesRoot, "assistant", chatId), { recursive: true });
    await writeFile(target, "# empty owner\n", "utf8");
    const workspacesRootReal = await realpath(workspacesRoot);
    const targetReal = await realpath(target);

    function patchedFilter(this: unknown[], callback: unknown, thisArg?: unknown): unknown[] {
      if (this.length === 3 && this[0] === "" && this[1] === chatId && this[2] === "file.md") {
        return Array.from(this);
      }
      const result = Reflect.apply(nativeFilter, this, [callback, thisArg]);
      if (Array.isArray(result)) return result;
      return [];
    }

    Object.defineProperty(Array.prototype, "filter", {
      configurable: true,
      value: patchedFilter,
      writable: true,
    });
    vi.resetModules();
    vi.doMock("node:path", async () => {
      const actual = await vi.importActual<typeof import("node:path")>("node:path");
      return {
        ...actual,
        relative: (from: string, to: string) => {
          if (from === workspacesRootReal && to === targetReal) return `/${chatId}/file.md`;
          return actual.relative(from, to);
        },
      };
    });

    try {
      const { buildMessageDocumentSnapshots } = await import("../runtime/doc-snapshots.js");
      const { docs, failedMentions } = await buildMessageDocumentSnapshots(`see ${target}`, home, {
        workspacesRoot,
        chatId,
        selfSlug: "coder",
      });

      expect(docs).toEqual([]);
      expect(failedMentions).toEqual([{ raw: target, reason: "unreadable" }]);
    } finally {
      Object.defineProperty(Array.prototype, "filter", {
        configurable: true,
        value: nativeFilter,
        writable: true,
      });
      await rm(workspacesRoot, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});
