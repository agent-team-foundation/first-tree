import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { rotateClientIdWithBackup } from "../core/client-reidentify.js";

describe("rotateClientIdWithBackup", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "first-tree-reidentify-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("backs up client.yaml and writes a fresh clientId", () => {
    const yamlPath = join(dir, "client.yaml");
    const before = {
      server: { url: "http://localhost:8000" },
      client: { id: "client_abcdef12" },
      logLevel: "info",
    };
    writeFileSync(yamlPath, stringifyYaml(before), { mode: 0o600 });

    const result = rotateClientIdWithBackup(dir);

    expect(result.oldId).toBe("client_abcdef12");
    expect(result.newId).toMatch(/^client_[a-f0-9]{8}$/);
    expect(result.newId).not.toBe("client_abcdef12");
    expect(result.backupPath).toBe(join(dir, "client.yaml.bak"));

    // Backup preserves the original id.
    expect(existsSync(result.backupPath)).toBe(true);
    const backup = parseYaml(readFileSync(result.backupPath, "utf-8")) as Record<string, unknown>;
    expect((backup.client as Record<string, unknown>).id).toBe("client_abcdef12");

    // New yaml carries the new id; other fields untouched.
    const updated = parseYaml(readFileSync(yamlPath, "utf-8")) as Record<string, unknown>;
    expect((updated.client as Record<string, unknown>).id).toBe(result.newId);
    expect((updated.server as Record<string, unknown>).url).toBe("http://localhost:8000");
    expect(updated.logLevel).toBe("info");
  });

  it("writes a fresh id even when client.id was missing", () => {
    const yamlPath = join(dir, "client.yaml");
    writeFileSync(yamlPath, stringifyYaml({ server: { url: "http://localhost:8000" } }), { mode: 0o600 });

    const result = rotateClientIdWithBackup(dir);

    expect(result.oldId).toBeNull();
    expect(result.newId).toMatch(/^client_[a-f0-9]{8}$/);

    const updated = parseYaml(readFileSync(yamlPath, "utf-8")) as Record<string, unknown>;
    expect((updated.client as Record<string, unknown>).id).toBe(result.newId);
  });

  it("throws when client.yaml does not exist", () => {
    expect(() => rotateClientIdWithBackup(dir)).toThrow(/does not exist/);
  });

  it("overwrites a previous backup on second rotation", () => {
    const yamlPath = join(dir, "client.yaml");
    writeFileSync(yamlPath, stringifyYaml({ client: { id: "client_11111111" } }), { mode: 0o600 });
    const first = rotateClientIdWithBackup(dir);

    // Second rotation: old becomes whatever first wrote.
    const second = rotateClientIdWithBackup(dir);
    expect(second.oldId).toBe(first.newId);
    const backup = parseYaml(readFileSync(second.backupPath, "utf-8")) as Record<string, unknown>;
    expect((backup.client as Record<string, unknown>).id).toBe(first.newId);
  });

  it("leaves the backup with the pre-rotation yaml content", () => {
    // Sanity check against a different working directory to rule out mkdir side-effects.
    const extraDir = mkdtempSync(join(tmpdir(), "first-tree-reidentify-extra-"));
    try {
      mkdirSync(extraDir, { recursive: true });
      const yamlPath = join(extraDir, "client.yaml");
      writeFileSync(yamlPath, stringifyYaml({ client: { id: "client_99999999" } }), { mode: 0o600 });

      const { backupPath } = rotateClientIdWithBackup(extraDir);
      const backup = parseYaml(readFileSync(backupPath, "utf-8")) as Record<string, unknown>;
      expect((backup.client as Record<string, unknown>).id).toBe("client_99999999");
    } finally {
      rmSync(extraDir, { recursive: true, force: true });
    }
  });
});
