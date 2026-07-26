/**
 * CLI output re-exports. The underlying implementation lives in
 * `core/output.ts` (the Print layer). Keep these thin wrappers so callers that
 * only depend on `cli/output.ts` keep working during the migration.
 */
import { type PrintErrorMetadata, print } from "../core/output.js";

export function success(data: unknown): void {
  print.result(data);
}

export function fail(code: string, message: string, exitCode = 1, metadata?: PrintErrorMetadata): never {
  return print.fail(code, message, exitCode, metadata);
}
