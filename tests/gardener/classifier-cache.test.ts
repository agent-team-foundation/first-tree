import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLASSIFIER_CACHE_DIR,
  classifierCachePath,
  readClassifierCache,
  writeClassifierCache,
  type ClassificationItem,
} from "#products/gardener/engine/sync.js";

const sample: ClassificationItem[] = [
  {
    path: "engineering/auth",
    type: "TREE_MISS",
    rationale: "new auth service",
    suggested_node_title: "Auth",
    suggested_node_body_markdown: "Body.",
  },
];

describe("classifier cache (#305)", () => {
  it("classifierCachePath lands under .first-tree/classification-cache/<hash>.json", () => {
    const root = "/tmp/some-tree";
    const p = classifierCachePath(root, "abc123");
    expect(p).toBe(join(root, CLASSIFIER_CACHE_DIR, "abc123.json"));
  });

  it("readClassifierCache returns null when the file does not exist", () => {
    const root = mkdtempSync(join(tmpdir(), "first-tree-cache-"));
    try {
      expect(readClassifierCache(root, "deadbeef")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writeClassifierCache → readClassifierCache round-trips proposals", () => {
    const root = mkdtempSync(join(tmpdir(), "first-tree-cache-"));
    try {
      writeClassifierCache(root, "abc123", sample);
      const out = readClassifierCache(root, "abc123");
      expect(out).toEqual(sample);
      expect(existsSync(classifierCachePath(root, "abc123"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("readClassifierCache returns null on malformed JSON (not a crash)", () => {
    const root = mkdtempSync(join(tmpdir(), "first-tree-cache-"));
    try {
      const p = classifierCachePath(root, "badhash");
      mkdirSync(join(root, CLASSIFIER_CACHE_DIR), { recursive: true });
      writeFileSync(p, "{ not valid json");
      expect(readClassifierCache(root, "badhash")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("readClassifierCache returns null when payload has no proposals array", () => {
    const root = mkdtempSync(join(tmpdir(), "first-tree-cache-"));
    try {
      const p = classifierCachePath(root, "nop");
      mkdirSync(join(root, CLASSIFIER_CACHE_DIR), { recursive: true });
      writeFileSync(p, JSON.stringify({ version: 1, createdAt: "x" }));
      expect(readClassifierCache(root, "nop")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes a versioned payload with createdAt + proposals (inspectable on disk)", () => {
    const root = mkdtempSync(join(tmpdir(), "first-tree-cache-"));
    try {
      writeClassifierCache(root, "v1hash", sample);
      const raw = JSON.parse(
        require("node:fs").readFileSync(classifierCachePath(root, "v1hash"), "utf8"),
      );
      expect(raw.version).toBe(1);
      expect(raw.promptHash).toBe("v1hash");
      expect(typeof raw.createdAt).toBe("string");
      expect(raw.proposals).toEqual(sample);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
