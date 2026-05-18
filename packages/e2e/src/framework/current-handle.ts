import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PACKAGE_E2E_ROOT } from "./env.js";

export const HANDLE_PATH = resolve(PACKAGE_E2E_ROOT, ".e2e-runs", "current.json");

export type CurrentRunHandle = {
  runId: string;
  serverBaseUrl: string;
  databaseUrl: string;
  clientHome: string;
};

export function readCurrentHandle(): CurrentRunHandle {
  return JSON.parse(readFileSync(HANDLE_PATH, "utf8")) as CurrentRunHandle;
}
