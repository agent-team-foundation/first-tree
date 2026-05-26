import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type PackageJson = {
  version?: unknown;
};

export function readCurrentCliVersion(): string {
  let currentDir = dirname(fileURLToPath(import.meta.url));

  while (true) {
    const candidate = join(currentDir, "package.json");
    if (existsSync(candidate)) {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as PackageJson;
      if (typeof parsed.version === "string" && parsed.version.length > 0) {
        return parsed.version;
      }
      throw new Error(`Could not read a CLI version from ${candidate}.`);
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error("Could not locate package.json for the first-tree CLI.");
    }

    currentDir = parentDir;
  }
}
