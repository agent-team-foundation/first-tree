import { describe, expect, it } from "vitest";

import { AUTO_DIR_ENV, resolveAutoPaths } from "../../src/runtime/paths.js";

describe("resolveAutoPaths", () => {
  it("exposes AUTO_DIR as the env override key", () => {
    expect(AUTO_DIR_ENV).toBe("AUTO_DIR");
  });

  it("falls back to ~/.first-tree/auto under the supplied home", () => {
    const paths = resolveAutoPaths({
      env: () => undefined,
      homeDir: () => "/home/u",
    });
    expect(paths.root).toBe("/home/u/.first-tree/auto");
    expect(paths.inbox).toBe("/home/u/.first-tree/auto/inbox.json");
    expect(paths.activityLog).toBe("/home/u/.first-tree/auto/activity.log");
    expect(paths.claimsDir).toBe("/home/u/.first-tree/auto/claims");
    expect(paths.identityCache).toBe("/home/u/.first-tree/auto/identity.json");
    expect(paths.inboxLock).toBe("/home/u/.first-tree/auto/inbox.json.lock");
  });

  it("honors $AUTO_DIR override", () => {
    const paths = resolveAutoPaths({
      env: (k) => (k === "AUTO_DIR" ? "/tmp/x" : undefined),
      homeDir: () => "/home/u",
    });
    expect(paths.root).toBe("/tmp/x");
    expect(paths.inbox).toBe("/tmp/x/inbox.json");
  });

  it("ignores empty $AUTO_DIR (treats as unset)", () => {
    const paths = resolveAutoPaths({
      env: (k) => (k === "AUTO_DIR" ? "" : undefined),
      homeDir: () => "/home/u",
    });
    expect(paths.root).toBe("/home/u/.first-tree/auto");
  });
});
