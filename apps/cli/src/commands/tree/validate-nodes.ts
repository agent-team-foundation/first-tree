import {
  type ContextContentClassCounts,
  collectContextMarkdownContent,
  emptyContentClassCounts,
} from "./content-class.js";
import {
  type ContextDocument,
  readContextDocument,
  readNonEmptyStringArrayField,
  readNonEmptyStringField,
} from "./context-document.js";
import { readMarkdownLinkTargets, resolveLocalTreeTarget } from "./context-links.js";
import {
  formatValidationFinding,
  type TreeValidationFinding,
  VALIDATION_CODES,
  type ValidationCode,
} from "./validation-finding.js";

const MEMBERS_INDEX_PATH = "members/NODE.md";

export type NodeValidationResult = {
  findings: TreeValidationFinding[];
  scannedByContentClass: ContextContentClassCounts;
};

function addFinding(
  findings: TreeValidationFinding[],
  code: ValidationCode,
  path: string,
  message: string,
  target?: string,
): void {
  findings.push({ code, message, path, ...(target === undefined ? {} : { target }) });
}

function validateRequiredNodeMetadata(
  document: ContextDocument,
  path: string,
  findings: TreeValidationFinding[],
): void {
  if (document.frontmatter === "missing") {
    addFinding(findings, VALIDATION_CODES.frontmatterMissing, path, "missing frontmatter");
    return;
  }

  if (document.frontmatter === "invalid" || document.data === null) {
    addFinding(
      findings,
      VALIDATION_CODES.frontmatterParse,
      path,
      `frontmatter could not be parsed${document.error === undefined ? "" : `: ${document.error}`}`,
    );
    return;
  }

  const title = readNonEmptyStringField(document.data, "title");
  if (!title.present) {
    addFinding(findings, VALIDATION_CODES.titleMissing, path, "missing 'title' field in frontmatter");
  } else if (!title.valid) {
    addFinding(findings, VALIDATION_CODES.titleInvalid, path, "'title' must be a non-empty string");
  }

  const owners = readNonEmptyStringArrayField(document.data, "owners");
  if (!owners.present) {
    addFinding(findings, VALIDATION_CODES.ownersMissing, path, "missing 'owners' field in frontmatter");
  } else if (!owners.valid) {
    addFinding(findings, VALIDATION_CODES.ownersInvalid, path, "'owners' must be a non-empty string array");
  }

  const description = readNonEmptyStringField(document.data, "description");
  if (description.present && !description.valid) {
    addFinding(
      findings,
      VALIDATION_CODES.descriptionInvalid,
      path,
      "'description' must be a non-empty string when present",
    );
  }
}

function readSoftLinks(document: ContextDocument, path: string, findings: TreeValidationFinding[]): string[] {
  if (document.data === null) {
    return [];
  }

  const softLinks = readNonEmptyStringArrayField(document.data, "soft_links");
  if (!softLinks.present) {
    return [];
  }
  if (!softLinks.valid) {
    addFinding(
      findings,
      VALIDATION_CODES.softLinksInvalid,
      path,
      "'soft_links' must be a non-empty string array when present",
    );
    return [];
  }
  return softLinks.value;
}

function validateSoftLinks(options: {
  allowArchive: boolean;
  document: ContextDocument;
  findings: TreeValidationFinding[];
  path: string;
  treeRoot: string;
}): void {
  for (const target of readSoftLinks(options.document, options.path, options.findings)) {
    const resolved = resolveLocalTreeTarget({
      sourcePath: options.path,
      target,
      treeRoot: options.treeRoot,
      softLink: true,
    });

    if (resolved === null || !resolved.exists) {
      addFinding(options.findings, VALIDATION_CODES.softLinkBroken, options.path, "broken soft_links target", target);
    }
    if (resolved === null) {
      continue;
    }
    if (!options.allowArchive && resolved.contentClass === "archive-supporting") {
      addFinding(
        options.findings,
        VALIDATION_CODES.softLinkArchiveDependency,
        options.path,
        "normal content must not link to archive/supporting content",
        target,
      );
    }
    if (resolved.escaped) {
      addFinding(
        options.findings,
        VALIDATION_CODES.softLinkPathEscape,
        options.path,
        "soft_links target resolves outside the Context Tree root",
        target,
      );
    }
  }
}

function validateMarkdownLinks(
  document: ContextDocument,
  path: string,
  treeRoot: string,
  findings: TreeValidationFinding[],
): void {
  for (const target of readMarkdownLinkTargets(document.body)) {
    const resolved = resolveLocalTreeTarget({ sourcePath: path, target, treeRoot, softLink: false });
    if (resolved === null) {
      continue;
    }
    if (resolved.contentClass === "archive-supporting") {
      addFinding(
        findings,
        VALIDATION_CODES.markdownArchiveDependency,
        path,
        "normal content must not link to archive/supporting content",
        target,
      );
    }
    if (resolved.escaped) {
      addFinding(
        findings,
        VALIDATION_CODES.markdownPathEscape,
        path,
        "Markdown link resolves outside the Context Tree root",
        target,
      );
    }
  }
}

export function collectNodeValidationFindings(treeRoot: string): NodeValidationResult {
  const findings: TreeValidationFinding[] = [];
  const scannedByContentClass = emptyContentClassCounts();
  const content = collectContextMarkdownContent(treeRoot);

  for (const directory of content.directorySymlinks) {
    addFinding(
      findings,
      directory.escaped ? VALIDATION_CODES.directorySymlinkPathEscape : VALIDATION_CODES.directorySymlinkUnsupported,
      directory.relativePath,
      directory.escaped
        ? "directory symlink resolves outside the Context Tree root"
        : "Context Tree domain directories must not be symlinks",
    );
  }

  for (const file of content.files) {
    scannedByContentClass[file.contentClass] += 1;

    if (file.unresolved) {
      addFinding(
        findings,
        VALIDATION_CODES.markdownFileSymlinkBroken,
        file.relativePath,
        "Markdown file symlink target cannot be resolved",
      );
      continue;
    }

    if (file.escaped) {
      addFinding(
        findings,
        VALIDATION_CODES.markdownFilePathEscape,
        file.relativePath,
        "Markdown file resolves outside the Context Tree root",
      );
      continue;
    }

    if (file.unsupported) {
      addFinding(
        findings,
        VALIDATION_CODES.markdownFileSymlinkUnsupported,
        file.relativePath,
        "Markdown file symlink must resolve to a regular file",
      );
      continue;
    }

    if (file.canonicalContentClass !== file.contentClass) {
      addFinding(
        findings,
        VALIDATION_CODES.markdownFileContentClassMismatch,
        file.relativePath,
        `Markdown file symlink crosses content-class boundary from ${file.contentClass} to ${file.canonicalContentClass}`,
        file.canonicalRelativePath,
      );
      continue;
    }

    if (file.contentClass === "repo-infra" || file.contentClass === "archive-supporting") {
      continue;
    }

    const document = readContextDocument(file.absolutePath);
    const personalMemberContent = file.contentClass === "member" && file.relativePath !== MEMBERS_INDEX_PATH;

    if (personalMemberContent) {
      if (document.frontmatter === "missing") {
        continue;
      }
      if (document.frontmatter === "invalid") {
        continue;
      }
      validateSoftLinks({
        allowArchive: true,
        document,
        findings,
        path: file.relativePath,
        treeRoot,
      });
      continue;
    }

    validateRequiredNodeMetadata(document, file.relativePath, findings);
    validateSoftLinks({
      allowArchive: file.contentClass === "member",
      document,
      findings,
      path: file.relativePath,
      treeRoot,
    });

    if (file.contentClass === "normal") {
      validateMarkdownLinks(document, file.relativePath, treeRoot, findings);
    }
  }

  return { findings, scannedByContentClass };
}

export function formatLegacyNodeError(finding: TreeValidationFinding): string {
  switch (finding.code) {
    case VALIDATION_CODES.frontmatterMissing:
      return `${finding.path}: missing frontmatter`;
    case VALIDATION_CODES.titleMissing:
      return `${finding.path}: missing 'title' field in frontmatter`;
    case VALIDATION_CODES.ownersMissing:
      return `${finding.path}: missing 'owners' field in frontmatter`;
    case VALIDATION_CODES.softLinkBroken:
      return `${finding.path}: broken soft_links target '${finding.target ?? ""}'`;
    default:
      return formatValidationFinding(finding);
  }
}

export function runValidateNodes(treeRoot: string): { errors: string[]; exitCode: number } {
  const errors = collectNodeValidationFindings(treeRoot).findings.map(formatLegacyNodeError);
  return { errors, exitCode: errors.length === 0 ? 0 : 1 };
}
