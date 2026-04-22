/**
 * Shared verdict-JSON parsing and tree-node grounding helpers used by
 * every classifier implementation. Extracted from `anthropic.ts` so the
 * upcoming `claude-cli.ts` classifier can reuse the exact same parsing
 * and hallucination-guarding logic without duplicating it.
 */

import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  ClassifyOutput,
  Severity,
  Verdict,
} from "../comment.js";

const VALID_VERDICTS: ReadonlySet<Verdict> = new Set<Verdict>([
  "ALIGNED",
  "NEW_TERRITORY",
  "NEEDS_REVIEW",
  "CONFLICT",
  "INSUFFICIENT_CONTEXT",
]);
const VALID_SEVERITIES: ReadonlySet<Severity> = new Set<Severity>([
  "low",
  "medium",
  "high",
  "critical",
]);

const MODEL_SUMMARY_CAP = 200;

/**
 * Model output can be wrapped in prose or code fences. Extract the
 * first JSON object and parse it. Returns null if no valid object.
 */
export function parseVerdictJson(text: string): ClassifyOutput | null {
  const stripped = text.replace(/```(?:json)?/gi, "").trim();
  const start = stripped.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let end = -1;
  for (let i = start; i < stripped.length; i += 1) {
    const c = stripped[i];
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;
  const slice = stripped.slice(start, end + 1);
  let obj: unknown;
  try {
    obj = JSON.parse(slice);
  } catch {
    return null;
  }
  return shapeToClassifyOutput(obj);
}

function shapeToClassifyOutput(obj: unknown): ClassifyOutput | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const verdict = o.verdict;
  const severity = o.severity;
  const summary = o.summary;
  if (typeof verdict !== "string" || !VALID_VERDICTS.has(verdict as Verdict)) {
    return null;
  }
  if (
    typeof severity !== "string" ||
    !VALID_SEVERITIES.has(severity as Severity)
  ) {
    return null;
  }
  if (typeof summary !== "string") return null;
  const nodesRaw = Array.isArray(o.treeNodes) ? o.treeNodes : [];
  const treeNodes: Array<{ path: string; summary: string }> = [];
  for (const n of nodesRaw) {
    if (!n || typeof n !== "object") continue;
    const nn = n as Record<string, unknown>;
    if (typeof nn.path === "string" && typeof nn.summary === "string") {
      treeNodes.push({ path: nn.path, summary: nn.summary });
    }
  }
  return {
    verdict: verdict as Verdict,
    severity: severity as Severity,
    summary: clampSummary(summary),
    treeNodes,
  };
}

/**
 * Drop cited tree nodes that don't exist on disk. Models sometimes
 * hallucinate plausible-looking paths; letting those through would
 * render broken links in the comment body.
 */
export function validateAndGroundNodes(
  out: ClassifyOutput,
  treeRoot: string,
): ClassifyOutput {
  const grounded = out.treeNodes.flatMap((n) => {
    const normalized = normalizeGroundedPath(treeRoot, n.path);
    if (!normalized || !existsSync(normalized.absolute)) return [];
    return [{ ...n, path: normalized.relative }];
  });
  return { ...out, treeNodes: grounded };
}

function clampSummary(summary: string): string {
  if (summary.length <= MODEL_SUMMARY_CAP) return summary;
  return summary.slice(0, MODEL_SUMMARY_CAP - 1) + "…";
}

function normalizeGroundedPath(
  treeRoot: string,
  citedPath: string,
): { absolute: string; relative: string } | null {
  if (isAbsolute(citedPath)) return null;
  const root = resolve(treeRoot);
  const absolute = resolve(root, citedPath);
  const relativePath = relative(root, absolute);
  if (
    relativePath.length === 0 ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath === ".." ||
    isAbsolute(relativePath)
  ) {
    return null;
  }
  return {
    absolute,
    relative: relativePath.split(sep).join("/"),
  };
}
