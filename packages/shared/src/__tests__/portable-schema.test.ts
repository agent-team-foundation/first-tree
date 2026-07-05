import { describe, expect, it } from "vitest";
import {
  PORTABLE_PLATFORMS,
  portableInstallMetadataSchema,
  portableLatestSchema,
  portableManifestSchema,
} from "../schemas/portable.js";

const base = {
  schemaVersion: 1,
  channel: "prod",
  version: "1.2.3",
  gitSha: "abcdef",
  nodeVersion: "v24.11.1",
  packageName: "first-tree",
  binName: "first-tree",
  aliasName: "ft",
  generatedAt: new Date().toISOString(),
} as const;

const asset = {
  platform: "linux-x64",
  fileName: "first-tree-1.2.3-linux-x64.tar.gz",
  url: "https://download.first-tree.ai/releases/prod/1.2.3/first-tree-1.2.3-linux-x64.tar.gz",
  sha256: "a".repeat(64),
  size: 123,
} as const;

describe("portable schemas", () => {
  it("lists the supported portable target platforms", () => {
    expect(PORTABLE_PLATFORMS).toEqual(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]);
  });

  it("parses immutable manifests and latest pointers", () => {
    expect(portableManifestSchema.parse({ ...base, assets: [asset] }).assets[0]?.platform).toBe("linux-x64");
    expect(
      portableLatestSchema.parse({
        ...base,
        manifestUrl: "https://download.first-tree.ai/releases/prod/1.2.3/manifest.json",
        assets: [asset],
      }).manifestUrl,
    ).toBe("https://download.first-tree.ai/releases/prod/1.2.3/manifest.json");
  });

  it("rejects unsupported platforms and malformed hashes", () => {
    expect(() =>
      portableManifestSchema.parse({
        ...base,
        assets: [{ ...asset, platform: "win32-x64" }],
      }),
    ).toThrow();
    expect(() =>
      portableManifestSchema.parse({
        ...base,
        assets: [{ ...asset, sha256: "not-a-hash" }],
      }),
    ).toThrow();
  });

  it("parses INSTALL.json metadata from an extracted artifact", () => {
    expect(
      portableInstallMetadataSchema.parse({
        ...base,
        platform: "darwin-arm64",
        installMode: "portable",
        appEntry: "app/cli/index.mjs",
      }).platform,
    ).toBe("darwin-arm64");
  });
});
