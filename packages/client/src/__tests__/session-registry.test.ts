import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionRegistry } from "../runtime/session-registry.js";

describe("SessionRegistry", () => {
  let testDir: string;
  let filePath: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `session-registry-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    filePath = join(testDir, "sessions.json");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(testDir, { recursive: true, force: true });
  });

  function makeEntries(data: Record<string, { claudeSessionId: string; lastActivity: number; status: string }>) {
    return new Map(Object.entries(data));
  }

  it("round-trips save and load", () => {
    const registry = new SessionRegistry(filePath);
    const entries = makeEntries({
      "chat-1": { claudeSessionId: "sess-aaa", lastActivity: 1700000000000, status: "active" },
      "chat-2": { claudeSessionId: "sess-bbb", lastActivity: 1700001000000, status: "suspended" },
    });

    registry.flush(entries);
    registry.dispose();

    const registry2 = new SessionRegistry(filePath);
    const loaded = registry2.load();
    registry2.dispose();

    expect(loaded.size).toBe(2);
    expect(loaded.get("chat-1")?.claudeSessionId).toBe("sess-aaa");
    expect(loaded.get("chat-1")?.lastActivity).toBe(1700000000000);
    expect(loaded.get("chat-1")?.status).toBe("active");
    expect(loaded.get("chat-2")?.claudeSessionId).toBe("sess-bbb");
    expect(loaded.get("chat-2")?.status).toBe("suspended");
  });

  it("returns empty map when file does not exist", () => {
    const registry = new SessionRegistry(join(testDir, "nonexistent.json"));
    const loaded = registry.load();
    registry.dispose();

    expect(loaded.size).toBe(0);
  });

  it("returns empty map on version mismatch", () => {
    writeFileSync(filePath, JSON.stringify({ version: 999, entries: { "chat-1": {} } }), "utf-8");

    const registry = new SessionRegistry(filePath);
    const loaded = registry.load();
    registry.dispose();

    expect(loaded.size).toBe(0);
  });

  it("returns empty map on corrupted JSON", () => {
    writeFileSync(filePath, "not valid json {{{{", "utf-8");

    const registry = new SessionRegistry(filePath);
    const loaded = registry.load();
    registry.dispose();

    expect(loaded.size).toBe(0);
  });

  it("creates directory if it does not exist", () => {
    const deepPath = join(testDir, "a", "b", "c", "sessions.json");
    const registry = new SessionRegistry(deepPath);

    registry.flush(
      makeEntries({
        "chat-1": { claudeSessionId: "sess-x", lastActivity: 1700000000000, status: "active" },
      }),
    );
    registry.dispose();

    expect(existsSync(deepPath)).toBe(true);
  });

  it("atomic write does not leave tmp file on success", () => {
    const registry = new SessionRegistry(filePath);
    registry.flush(
      makeEntries({
        "chat-1": { claudeSessionId: "sess-x", lastActivity: 1700000000000, status: "active" },
      }),
    );
    registry.dispose();

    expect(existsSync(filePath)).toBe(true);
    expect(existsSync(`${filePath}.tmp`)).toBe(false);
  });

  it("debounced save writes after timeout", async () => {
    const registry = new SessionRegistry(filePath);
    const entries = makeEntries({
      "chat-1": { claudeSessionId: "sess-x", lastActivity: 1700000000000, status: "active" },
    });

    registry.save(entries);

    // File should not exist immediately (debounced)
    expect(existsSync(filePath)).toBe(false);

    // Wait for debounce timeout (1 second + buffer)
    await new Promise((r) => setTimeout(r, 1200));

    expect(existsSync(filePath)).toBe(true);
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(raw.entries["chat-1"].claudeSessionId).toBe("sess-x");

    registry.dispose();
  });

  it("flush cancels a pending debounced save", () => {
    vi.useFakeTimers();
    const registry = new SessionRegistry(filePath);
    const entries = makeEntries({
      "chat-1": { claudeSessionId: "sess-x", lastActivity: 1700000000000, status: "active" },
    });

    registry.save(entries);
    registry.flush(entries);
    vi.advanceTimersByTime(1000);

    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(raw.entries["chat-1"].claudeSessionId).toBe("sess-x");
    registry.dispose();
  });

  it("dispose flushes a pending debounced save", () => {
    vi.useFakeTimers();
    const registry = new SessionRegistry(filePath);
    const entries = makeEntries({
      "chat-1": { claudeSessionId: "sess-x", lastActivity: 1700000000000, status: "active" },
    });

    registry.save(entries);
    registry.dispose();
    // flush() already cancelled the timer — nothing more should fire.
    vi.advanceTimersByTime(1000);

    expect(existsSync(filePath)).toBe(true);
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(raw.entries["chat-1"].claudeSessionId).toBe("sess-x");
  });

  it("dispose without a pending save writes nothing", () => {
    vi.useFakeTimers();
    const registry = new SessionRegistry(filePath);

    registry.dispose();
    vi.advanceTimersByTime(1000);

    expect(existsSync(filePath)).toBe(false);
  });

  it("logs persistence failures without throwing", () => {
    const parentAsFile = join(testDir, "not-a-directory");
    writeFileSync(parentAsFile, "file blocks mkdir", "utf-8");
    const registry = new SessionRegistry(join(parentAsFile, "sessions.json"));
    const stderrMessages: string[] = [];
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation((message: string | Uint8Array) => {
      stderrMessages.push(String(message));
      return true;
    });

    expect(() =>
      registry.flush(
        makeEntries({
          "chat-1": { claudeSessionId: "sess-x", lastActivity: 1700000000000, status: "active" },
        }),
      ),
    ).not.toThrow();

    expect(stderrMessages.join("")).toContain("[session-registry] Failed to persist:");
    stderrWrite.mockRestore();
  });

  it("logs non-Error persistence failures", async () => {
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        mkdirSync: () => {
          throw "mkdir failed";
        },
      };
    });
    const mod = await import("../runtime/session-registry.js");
    const registry = new mod.SessionRegistry(filePath);
    const stderrMessages: string[] = [];
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation((message: string | Uint8Array) => {
      stderrMessages.push(String(message));
      return true;
    });

    registry.flush(
      makeEntries({
        "chat-1": { claudeSessionId: "sess-x", lastActivity: 1700000000000, status: "active" },
      }),
    );

    expect(stderrMessages.join("")).toContain("mkdir failed");
    stderrWrite.mockRestore();
    vi.doUnmock("node:fs");
    vi.resetModules();
  });
});
