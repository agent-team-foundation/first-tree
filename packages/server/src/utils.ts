import { createHash } from "node:crypto";

/** SHA-256 hash for agent token verification. */
export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Serialize a Date to ISO string, or null. */
export function serializeDate(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}
