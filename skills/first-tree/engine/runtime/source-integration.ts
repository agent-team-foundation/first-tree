import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  SOURCE_INTEGRATION_FILES,
  SOURCE_INTEGRATION_MARKER,
} from "#skill/engine/runtime/asset-loader.js";

export type SourceIntegrationFile = (typeof SOURCE_INTEGRATION_FILES)[number];

export interface SourceIntegrationUpdate {
  action: "created" | "updated" | "unchanged";
  file: SourceIntegrationFile;
}

export function buildSourceIntegrationLine(treeRepoName: string): string {
  return (
    `${SOURCE_INTEGRATION_MARKER} Use the installed \`first-tree\` skill here;`
    + ` keep all Context Tree files only in the sibling dedicated`
    + ` \`${treeRepoName}\` repo/submodule and update that tree when decisions`
    + " or constraints change."
  );
}

export function hasSourceIntegrationMarker(text: string | null): boolean {
  if (text === null) {
    return false;
  }
  return text
    .replaceAll("\r\n", "\n")
    .split("\n")
    .some((line) => line.startsWith(SOURCE_INTEGRATION_MARKER));
}

export function upsertSourceIntegrationFiles(
  root: string,
  treeRepoName: string,
): SourceIntegrationUpdate[] {
  return SOURCE_INTEGRATION_FILES.map((file) =>
    upsertSourceIntegrationFile(root, file, treeRepoName),
  );
}

function upsertSourceIntegrationFile(
  root: string,
  file: SourceIntegrationFile,
  treeRepoName: string,
): SourceIntegrationUpdate {
  const fullPath = join(root, file);
  const exists = existsSync(fullPath);
  const nextLine = buildSourceIntegrationLine(treeRepoName);
  const current = exists ? readFileSync(fullPath, "utf-8") : null;
  const normalized = current?.replaceAll("\r\n", "\n") ?? "";
  const lines = normalized === "" ? [] : normalized.split("\n");
  const markerIndex = lines.findIndex((line) =>
    line.startsWith(SOURCE_INTEGRATION_MARKER),
  );

  if (markerIndex >= 0) {
    if (lines[markerIndex] === nextLine) {
      return { action: "unchanged", file };
    }
    lines[markerIndex] = nextLine;
  } else {
    if (lines.length > 0 && lines.at(-1) !== "") {
      lines.push("");
    }
    lines.push(nextLine);
  }

  let nextText = lines.join("\n");
  if (nextText !== "" && !nextText.endsWith("\n")) {
    nextText += "\n";
  }
  writeFileSync(fullPath, nextText);

  return {
    action: exists ? "updated" : "created",
    file,
  };
}
