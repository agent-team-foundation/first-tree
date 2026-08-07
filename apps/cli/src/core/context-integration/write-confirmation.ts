import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type ContextTreeActiveBinding, contextTreeActiveBindingSchema } from "@first-tree/shared";
import { defaultHome } from "@first-tree/shared/config";
import { readActiveContextAccountClientId } from "./account-state-guard.js";

const PLAN_TTL_MS = 60 * 60_000;

export type ContextWritePlanReceipt = {
  schemaVersion: 1;
  accountClientId: string;
  planAnchor: string;
  candidateId: string;
  organizationId: string;
  binding: ContextTreeActiveBinding;
  commit: string;
  createdAt: string;
};

export function writeContextWritePlanReceipt(
  input: Omit<ContextWritePlanReceipt, "schemaVersion" | "accountClientId" | "createdAt">,
): ContextWritePlanReceipt {
  assertAnchor(input.planAnchor);
  const receipt: ContextWritePlanReceipt = {
    schemaVersion: 1,
    accountClientId: readActiveContextAccountClientId(),
    ...input,
    createdAt: new Date().toISOString(),
  };
  const path = receiptPath(receipt.organizationId, receipt.planAnchor);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  return receipt;
}

export function readContextWritePlanReceipt(organizationId: string, planAnchor: string): ContextWritePlanReceipt {
  assertAnchor(planAnchor);
  const path = receiptPath(organizationId, planAnchor);
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof value !== "object" || value === null) throw new Error("Invalid Context write plan receipt.");
  const receipt = value as Partial<ContextWritePlanReceipt>;
  const binding = contextTreeActiveBindingSchema.safeParse(receipt.binding);
  const expired =
    typeof receipt.createdAt === "string" &&
    Number.isFinite(Date.parse(receipt.createdAt)) &&
    Date.now() - Date.parse(receipt.createdAt) > PLAN_TTL_MS;
  if (expired) rmSync(path, { force: true });
  if (
    receipt.schemaVersion !== 1 ||
    receipt.accountClientId !== readActiveContextAccountClientId() ||
    receipt.planAnchor !== planAnchor ||
    receipt.organizationId !== organizationId ||
    typeof receipt.candidateId !== "string" ||
    !/^[0-9a-f]{40,64}$/u.test(receipt.commit ?? "") ||
    typeof receipt.createdAt !== "string" ||
    !Number.isFinite(Date.parse(receipt.createdAt)) ||
    expired ||
    !binding.success
  ) {
    throw new Error("Context write plan receipt is invalid, expired, or belongs to another local account.");
  }
  return { ...(receipt as ContextWritePlanReceipt), binding: binding.data };
}

export function consumeContextWritePlanReceipt(organizationId: string, planAnchor: string): void {
  rmSync(receiptPath(organizationId, planAnchor), { force: true });
}

function receiptPath(organizationId: string, planAnchor: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(organizationId)) throw new Error("Invalid organization id.");
  return join(defaultHome(), "state", "context", "byo", organizationId, "write-plans", `${planAnchor}.json`);
}

function assertAnchor(value: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error("Invalid Context write plan anchor.");
}
