import { readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DEFAULT_DATA_DIR } from "@first-tree/shared/config";
import { AppError, ForbiddenError, NotFoundError } from "../errors.js";

const MAX_DOC_BYTES = 5 * 1024 * 1024;

export type WorkspaceDocPreviewInput = {
  chatId: string;
  agentId: string;
  agentName: string;
  path: string;
  basePath?: string;
  workspacesRoot?: string;
};

export type MeDocPreview = {
  ref: {
    type: "workspace";
    chatId: string;
    agentId: string;
    basePath?: string;
    path: string;
  };
  path: string;
  content: string;
};

export async function getMeDocPreview(input: WorkspaceDocPreviewInput): Promise<MeDocPreview> {
  const workspacesRoot = input.workspacesRoot ?? join(DEFAULT_DATA_DIR, "workspaces");
  const workspaceRoot = join(workspacesRoot, input.agentName, input.chatId);
  const workspaceRootReal = await realpathOrNotFound(workspaceRoot);
  const relativePath = join(input.basePath ?? "", input.path);
  const candidate = resolve(workspaceRootReal, relativePath);
  const relativeCandidate = assertInsideWorkspace(workspaceRootReal, candidate);

  if (extname(relativeCandidate).toLowerCase() !== ".md") {
    throw new ForbiddenError("Document preview only supports markdown files in the agent workspace");
  }

  let fileStat: Awaited<ReturnType<typeof stat>>;
  try {
    fileStat = await stat(candidate);
  } catch {
    throw new NotFoundError("Document not found");
  }

  if (!fileStat.isFile()) {
    throw new NotFoundError("Document not found");
  }
  if (fileStat.size > MAX_DOC_BYTES) {
    throw new AppError(413, "Document is larger than the 5MB preview limit");
  }

  const fileReal = await realpath(candidate);
  const normalizedPath = assertInsideWorkspace(workspaceRootReal, fileReal);
  const refPath = normalizeRefPath(input.path);
  const normalizedBasePath = input.basePath ? normalizeRefPath(input.basePath) : undefined;

  return {
    ref: {
      type: "workspace",
      chatId: input.chatId,
      agentId: input.agentId,
      ...(normalizedBasePath ? { basePath: normalizedBasePath } : {}),
      path: refPath,
    },
    path: normalizedPath,
    content: await readFile(fileReal, "utf8"),
  };
}

async function realpathOrNotFound(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    throw new NotFoundError("Document not found");
  }
}

function assertInsideWorkspace(workspaceRoot: string, target: string): string {
  const rel = relative(workspaceRoot, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new ForbiddenError("Document path must stay inside the agent workspace");
  }
  return rel.split(sep).join("/");
}

function normalizeRefPath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split(/[\\/]/)) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) throw new ForbiddenError("Document path must stay inside the agent workspace");
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  if (parts.length === 0) throw new ForbiddenError("Document path must name a markdown file");
  return parts.join("/");
}
