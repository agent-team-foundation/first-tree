import { describe, expect, it } from "vitest";
import {
  isOrgSettingNamespace,
  orgContextTreeInputSchema,
  orgSettingNamespaceSchema,
  orgSourceReposInputSchema,
} from "../schemas/org-settings.js";

describe("org settings schemas", () => {
  it("accepts supported repository URL forms", () => {
    expect(orgContextTreeInputSchema.parse({ repo: "https://github.com/org/tree.git" }).repo).toBe(
      "https://github.com/org/tree.git",
    );
    expect(orgContextTreeInputSchema.parse({ repo: "ssh://git@github.com/org/tree.git" }).repo).toBe(
      "ssh://git@github.com/org/tree.git",
    );
    expect(orgContextTreeInputSchema.parse({ repo: "git@github.com:org/tree.git" }).repo).toBe(
      "git@github.com:org/tree.git",
    );
  });

  it("rejects unsupported or malformed repository URLs", () => {
    expect(() => orgContextTreeInputSchema.parse({ repo: "not a url" })).toThrow(
      "Repo URL must be HTTPS, SSH (ssh://...), or scp-like (git@host:path).",
    );
    expect(() => orgContextTreeInputSchema.parse({ repo: "http://github.com/org/tree.git" })).toThrow(
      "Repo URL must use HTTPS or SSH.",
    );
    expect(() => orgContextTreeInputSchema.parse({ repo: "git://github.com/org/tree.git" })).toThrow(
      "Repo URL must use HTTPS or SSH.",
    );
    expect(() => orgContextTreeInputSchema.parse({ repo: "https://user@github.com/org/tree.git" })).toThrow(
      "Repo URL must not include credentials.",
    );
    expect(() => orgContextTreeInputSchema.parse({ repo: "ssh://git:secret@github.com/org/tree.git" })).toThrow(
      "Repo URL must not include credentials.",
    );
    expect(() => orgContextTreeInputSchema.parse({ repo: "github.com:1234" })).toThrow(
      "Repo URL must use HTTPS or SSH.",
    );
  });

  it("validates source repo list entries with the same URL rules", () => {
    expect(
      orgSourceReposInputSchema.parse({
        repos: [{ url: "git@github.com:org/repo.git", defaultBranch: "main" }],
      }),
    ).toEqual({
      repos: [{ url: "git@github.com:org/repo.git", defaultBranch: "main" }],
    });

    expect(() =>
      orgSourceReposInputSchema.parse({
        repos: [{ url: "https://github.com/org/repo.git", defaultBranch: "" }],
      }),
    ).toThrow();
  });

  it("checks setting namespace values", () => {
    expect(orgSettingNamespaceSchema.parse("context_tree")).toBe("context_tree");
    expect(isOrgSettingNamespace("context_tree")).toBe(true);
    expect(isOrgSettingNamespace("source_repos")).toBe(true);
    expect(isOrgSettingNamespace("unknown")).toBe(false);
    expect(isOrgSettingNamespace(null)).toBe(false);
  });
});
