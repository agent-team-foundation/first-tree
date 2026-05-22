import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { ensureTrailingNewline } from "./shared.js";

const TEMPLATE_VERSION_RE = /^# first-tree-template-version:\s*(\d+)\s*$/u;

export type TemplateWriteResult =
  | { kind: "written" }
  | { kind: "skipped-existing-no-marker" }
  | { kind: "skipped-same-version" }
  | { kind: "needs-upgrade"; currentVersion: number; templateVersion: number };

export function describeTemplateWriteResult(path: string, result: TemplateWriteResult): string {
  switch (result.kind) {
    case "written":
      return `Installed ${path}.`;
    case "skipped-existing-no-marker":
      return `Skipped ${path} because it has no first-tree template marker (treating it as user-customized).`;
    case "skipped-same-version":
      return `Left ${path} unchanged (already at the current first-tree template version).`;
    case "needs-upgrade":
      return `Left ${path} unchanged because it is on managed template version ${result.currentVersion}; manual upgrade needed for version ${result.templateVersion}.`;
    default:
      return `Left ${path} unchanged.`;
  }
}

function readVersionMarker(text: string): number | null {
  const firstLine = text.replaceAll("\r\n", "\n").split("\n", 1)[0] ?? "";
  const match = firstLine.match(TEMPLATE_VERSION_RE);
  return match ? Number(match[1]) : null;
}

export function parseTemplateVersion(path: string): number | null {
  if (!existsSync(path)) {
    return null;
  }

  try {
    return readVersionMarker(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function writeTemplatedFile(path: string, contents: string, opts: { version: number }): TemplateWriteResult {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, ensureTrailingNewline(contents.trimEnd()));
    return { kind: "written" };
  }

  const currentVersion = parseTemplateVersion(path);
  if (currentVersion === null) {
    return { kind: "skipped-existing-no-marker" };
  }

  if (currentVersion >= opts.version) {
    return { kind: "skipped-same-version" };
  }

  return {
    kind: "needs-upgrade",
    currentVersion,
    templateVersion: opts.version,
  };
}
