import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type PackageJson = {
  version?: unknown;
};

function resolvePackageJsonPath(): string {
  const candidates = [
    new URL("../../package.json", import.meta.url),
    new URL("../package.json", import.meta.url),
  ];

  for (const candidate of candidates) {
    const path = fileURLToPath(candidate);
    if (existsSync(path)) return path;
  }

  throw new Error("could not locate package.json while resolving the github-scan version");
}

function loadVersion(): string {
  const parsed = JSON.parse(
    readFileSync(resolvePackageJsonPath(), "utf8"),
  ) as PackageJson;

  if (typeof parsed.version === "string" && parsed.version.length > 0) {
    return parsed.version;
  }

  throw new Error("package.json is missing a valid string version");
}

export const GITHUB_SCAN_VERSION = loadVersion();
