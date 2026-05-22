import { print } from "../../../core/output.js";

/** Recursively print a nested config object with secret-aware masking. */
export function printFlat(
  obj: Record<string, unknown>,
  schema: Record<string, unknown>,
  prefix: string,
  showSecrets: boolean,
): void {
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      printFlat(value as Record<string, unknown>, schema, fullKey, showSecrets);
    } else {
      const secret = isSecretField(schema, fullKey) && !showSecrets;
      const display = secret ? "***" : String(value);
      print.line(`  ${fullKey.padEnd(30)} ${display}\n`);
    }
  }
}

/** Walk the schema tree to check if a dot-path field carries `secret: true`. */
export function isSecretField(schema: Record<string, unknown>, dotPath: string): boolean {
  const parts = dotPath.split(".");
  let current: unknown = schema;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") return false;
    const obj = current as Record<string, unknown>;
    if (obj._tag === "optional") {
      current = (obj.shape as Record<string, unknown>)[part];
    } else if (obj._tag === "field") {
      return false;
    } else {
      current = obj[part];
    }
  }
  if (typeof current === "object" && current !== null && "_tag" in current) {
    const field = current as { _tag: string; options?: { secret?: boolean } };
    if (field._tag === "field") {
      return field.options?.secret ?? false;
    }
  }
  return false;
}
