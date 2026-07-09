import { randomBytes } from "node:crypto";

/** Generate a UUID v7 (time-ordered). No external dependency. */
export function uuidv7(): string {
  const now = BigInt(Date.now());
  const bytes = new Uint8Array(16);

  bytes[0] = Number((now >> 40n) & 0xffn);
  bytes[1] = Number((now >> 32n) & 0xffn);
  bytes[2] = Number((now >> 24n) & 0xffn);
  bytes[3] = Number((now >> 16n) & 0xffn);
  bytes[4] = Number((now >> 8n) & 0xffn);
  bytes[5] = Number(now & 0xffn);

  const rand = randomBytes(10);
  for (let i = 0; i < 10; i++) {
    const b = rand[i];
    if (b !== undefined) bytes[6 + i] = b;
  }

  // Version 7 — randomBytes always fills indices 6..15 above.
  const versionNibble = bytes[6] as number;
  const variantByte = bytes[8] as number;
  bytes[6] = (versionNibble & 0x0f) | 0x70;
  // Variant 10xx
  bytes[8] = (variantByte & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
