import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BOOTSTRAP_STATE } from "#skill/engine/runtime/asset-loader.js";

export interface BootstrapState {
  sourceRepoName: string;
  sourceRepoPath: string;
  treeRepoName: string;
}

export function bootstrapStatePath(root: string): string {
  return join(root, BOOTSTRAP_STATE);
}

export function readBootstrapState(root: string): BootstrapState | null {
  const path = bootstrapStatePath(root);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<BootstrapState>;
    if (
      typeof parsed.sourceRepoName !== "string"
      || typeof parsed.sourceRepoPath !== "string"
      || typeof parsed.treeRepoName !== "string"
    ) {
      return null;
    }
    return {
      sourceRepoName: parsed.sourceRepoName,
      sourceRepoPath: parsed.sourceRepoPath,
      treeRepoName: parsed.treeRepoName,
    };
  } catch {
    return null;
  }
}

export function writeBootstrapState(root: string, state: BootstrapState): void {
  const path = bootstrapStatePath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}
