import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { toTreeRelativePosixPath } from "./content-class.js";
import { readContextDocument, readNonEmptyStringArrayField, readNonEmptyStringField } from "./context-document.js";
import {
  formatValidationFinding,
  type TreeValidationFinding,
  VALIDATION_CODES,
  type ValidationCode,
} from "./validation-finding.js";

const VALID_TYPES = new Set(["human", "agent"]);
const VALID_STATUSES = new Set(["invited"]);

export type MemberValidationResult = {
  findings: TreeValidationFinding[];
};

function addFinding(findings: TreeValidationFinding[], code: ValidationCode, path: string, message: string): void {
  findings.push({ code, message, path });
}

function validateMember(nodePath: string, treeRoot: string): TreeValidationFinding[] {
  const findings: TreeValidationFinding[] = [];
  const location = toTreeRelativePosixPath(treeRoot, nodePath);
  const document = readContextDocument(nodePath);

  if (document.frontmatter === "missing") {
    addFinding(findings, VALIDATION_CODES.memberFrontmatterMissing, location, "no frontmatter found");
    return findings;
  }
  if (document.frontmatter === "invalid" || document.data === null) {
    addFinding(
      findings,
      VALIDATION_CODES.memberFrontmatterParse,
      location,
      `frontmatter could not be parsed${document.error === undefined ? "" : `: ${document.error}`}`,
    );
    return findings;
  }

  const title = readNonEmptyStringField(document.data, "title");
  if (!title.valid) {
    addFinding(findings, VALIDATION_CODES.memberTitleInvalid, location, "missing or invalid 'title' field");
  }

  const owners = readNonEmptyStringArrayField(document.data, "owners");
  if (!owners.present) {
    addFinding(findings, VALIDATION_CODES.memberOwnersMissing, location, "missing 'owners' field");
  } else if (!owners.valid) {
    addFinding(findings, VALIDATION_CODES.memberOwnersInvalid, location, "'owners' must be a non-empty string array");
  }

  const memberType = readNonEmptyStringField(document.data, "type");
  if (!memberType.present) {
    addFinding(findings, VALIDATION_CODES.memberTypeMissing, location, "missing 'type' field");
  } else if (!memberType.valid) {
    addFinding(findings, VALIDATION_CODES.memberTypeShape, location, "'type' must be a non-empty string");
  } else if (!VALID_TYPES.has(memberType.value)) {
    addFinding(
      findings,
      VALIDATION_CODES.memberTypeInvalid,
      location,
      `invalid type '${memberType.value}' — must be one of: ${[...VALID_TYPES].sort().join(", ")}`,
    );
  }

  const status = readNonEmptyStringField(document.data, "status");
  if (status.present && !status.valid) {
    addFinding(
      findings,
      VALIDATION_CODES.memberStatusShape,
      location,
      "'status' must be a non-empty string when present",
    );
  } else if (status.valid && !VALID_STATUSES.has(status.value)) {
    addFinding(
      findings,
      VALIDATION_CODES.memberStatusInvalid,
      location,
      `invalid status '${status.value}' — must be one of: ${[...VALID_STATUSES].sort().join(", ")}`,
    );
  }

  const role = readNonEmptyStringField(document.data, "role");
  if (!role.present) {
    addFinding(findings, VALIDATION_CODES.memberRoleInvalid, location, "missing 'role' field");
  } else if (!role.valid) {
    addFinding(findings, VALIDATION_CODES.memberRoleShape, location, "'role' must be a non-empty string");
  }

  const domains = readNonEmptyStringArrayField(document.data, "domains");
  if (!domains.present) {
    addFinding(findings, VALIDATION_CODES.memberDomainsInvalid, location, "missing 'domains' field");
  } else if (!domains.valid) {
    const value = document.data.domains;
    addFinding(
      findings,
      Array.isArray(value) && value.length === 0
        ? VALIDATION_CODES.memberDomainsInvalid
        : VALIDATION_CODES.memberDomainsShape,
      location,
      Array.isArray(value) && value.length === 0
        ? "'domains' must contain at least one entry"
        : "'domains' must be a non-empty string array",
    );
  }

  return findings;
}

export function collectMemberValidationFindings(treeRoot: string): MemberValidationResult {
  const membersDir = join(treeRoot, "members");
  const findings: TreeValidationFinding[] = [];

  if (!existsSync(membersDir)) {
    addFinding(
      findings,
      VALIDATION_CODES.membersDirectoryMissing,
      "members/",
      `Members directory not found: ${membersDir}`,
    );
    return { findings };
  }

  try {
    const membersStat = lstatSync(membersDir);
    if (membersStat.isSymbolicLink()) {
      return { findings };
    }
    if (!membersStat.isDirectory()) {
      addFinding(
        findings,
        VALIDATION_CODES.membersDirectoryMissing,
        "members/",
        `Members directory not found: ${membersDir}`,
      );
      return { findings };
    }
  } catch {
    addFinding(
      findings,
      VALIDATION_CODES.membersDirectoryMissing,
      "members/",
      `Members directory not found: ${membersDir}`,
    );
    return { findings };
  }

  let memberCount = 0;

  // Top-level directories under members are member nodes. Nested directories
  // may be personal containers; nested NODE.md files still use this contract.
  function walk(dir: string, requireNode: boolean): void {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        continue;
      }
      const childPath = join(dir, entry.name);

      const nodePath = join(childPath, "NODE.md");
      if (!existsSync(nodePath)) {
        if (requireNode) {
          const path = `${toTreeRelativePosixPath(treeRoot, childPath)}/`;
          addFinding(findings, VALIDATION_CODES.memberNodeMissing, path, "directory exists but is missing NODE.md");
          walk(childPath, false);
        }
        continue;
      }

      memberCount += 1;
      findings.push(...validateMember(nodePath, treeRoot));
      walk(childPath, false);
    }
  }

  walk(membersDir, true);

  if (memberCount === 0) {
    addFinding(findings, VALIDATION_CODES.memberNodesEmpty, "members/", "no member nodes were found");
  }

  return { findings };
}

export function formatLegacyMemberError(finding: TreeValidationFinding): string {
  switch (finding.code) {
    case VALIDATION_CODES.memberFrontmatterMissing:
      return `${finding.path}: no frontmatter found`;
    case VALIDATION_CODES.memberTitleInvalid:
      return `${finding.path}: missing or empty 'title' field`;
    case VALIDATION_CODES.memberOwnersMissing:
      return `${finding.path}: missing 'owners' field`;
    case VALIDATION_CODES.memberTypeMissing:
      return `${finding.path}: missing 'type' field`;
    case VALIDATION_CODES.memberTypeInvalid:
    case VALIDATION_CODES.memberStatusInvalid:
      return `${finding.path}: ${finding.message}`;
    case VALIDATION_CODES.memberRoleInvalid:
      return `${finding.path}: missing or empty 'role' field`;
    case VALIDATION_CODES.memberDomainsInvalid:
      return `${finding.path}: ${finding.message}`;
    case VALIDATION_CODES.membersDirectoryMissing:
      return finding.message;
    case VALIDATION_CODES.memberNodeMissing:
      return `${finding.path}: directory exists but missing NODE.md`;
    case VALIDATION_CODES.memberNodesEmpty:
      return "members/: no member nodes were found";
    default:
      return formatValidationFinding(finding);
  }
}

export function runValidateMembers(treeRoot: string): { errors: string[]; exitCode: number } {
  const errors = collectMemberValidationFindings(treeRoot).findings.map(formatLegacyMemberError);
  return { errors, exitCode: errors.length === 0 ? 0 : 1 };
}
