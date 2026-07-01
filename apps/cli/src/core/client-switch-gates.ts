import { existsSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultHome } from "@first-tree/shared/config";
import type { ServiceInfo, ServiceOpResult } from "./service-install.js";

export type ClientSwitchPaths = {
  home: string;
  stateDir: string;
  lockPath: string;
  journalPath: string;
  parkedClientsDir: string;
};

export type ClientSwitchMaintenanceState = ClientSwitchPaths & {
  lockExists: boolean;
  journalExists: boolean;
  blocked: boolean;
  reason: "lock" | "journal" | "lock-and-journal" | null;
};

export class ClientSwitchMaintenanceError extends Error {
  constructor(readonly state: ClientSwitchMaintenanceState) {
    super(formatMaintenanceBlockedMessage(state));
    this.name = "ClientSwitchMaintenanceError";
  }
}

export class ClientSwitchServiceError extends Error {
  constructor(
    message: string,
    readonly service?: Pick<ServiceInfo, "platform" | "state" | "detail" | "label">,
  ) {
    super(message);
    this.name = "ClientSwitchServiceError";
  }
}

export class ClientSwitchFilesystemError extends Error {
  constructor(
    message: string,
    readonly move?: DirectoryMovePlan,
    readonly causeCode?: string,
  ) {
    super(message);
    this.name = "ClientSwitchFilesystemError";
  }
}

type ExistsFn = (path: string) => boolean;

export function clientSwitchPaths(home = defaultHome()): ClientSwitchPaths {
  const stateDir = join(home, "state");
  return {
    home,
    stateDir,
    lockPath: join(stateDir, "client-switch.lock"),
    journalPath: join(stateDir, "client-switch-journal.json"),
    parkedClientsDir: join(home, "parked-clients"),
  };
}

export function readClientSwitchMaintenanceState(
  home = defaultHome(),
  deps: { exists?: ExistsFn } = {},
): ClientSwitchMaintenanceState {
  const paths = clientSwitchPaths(home);
  const exists = deps.exists ?? existsSync;
  const lockExists = exists(paths.lockPath);
  const journalExists = exists(paths.journalPath);
  const reason =
    lockExists && journalExists ? "lock-and-journal" : lockExists ? "lock" : journalExists ? "journal" : null;
  return {
    ...paths,
    lockExists,
    journalExists,
    blocked: reason !== null,
    reason,
  };
}

export function assertDaemonStartupAllowedDuringClientSwitch(
  home = defaultHome(),
  deps: { exists?: ExistsFn } = {},
): void {
  const state = readClientSwitchMaintenanceState(home, deps);
  if (state.blocked) throw new ClientSwitchMaintenanceError(state);
}

function formatMaintenanceBlockedMessage(state: ClientSwitchMaintenanceState): string {
  if (state.reason === "lock") {
    return `client switch in progress (${state.lockPath}); daemon startup is blocked before reading root client state`;
  }
  if (state.reason === "journal") {
    return `client switch recovery required (${state.journalPath}); daemon startup is blocked before reading root client state`;
  }
  return `client switch in progress (${state.lockPath}, ${state.journalPath}); daemon startup is blocked before reading root client state`;
}

export function assertServiceInactiveForClientSwitch(service: ServiceInfo): void {
  if (service.state === "inactive" || service.state === "not-installed") return;
  const detail = service.detail ? `: ${service.detail}` : "";
  throw new ClientSwitchServiceError(
    `daemon service must be inactive before client switch; observed ${service.platform} state=${service.state}${detail}`,
    service,
  );
}

export function stopServiceForClientSwitch(deps: {
  stop: () => ServiceOpResult;
  status: () => ServiceInfo;
}): ServiceInfo {
  const stopped = deps.stop();
  if (!stopped.ok) {
    throw new ClientSwitchServiceError(`daemon service stop failed before client switch: ${stopped.reason}`);
  }
  const after = deps.status();
  assertServiceInactiveForClientSwitch(after);
  return after;
}

export type DirectoryMovePlan = {
  name: string;
  from: string;
  to: string;
};

type StatLike = { dev: number };
type RenameDeps = {
  stat?: (path: string) => StatLike;
  rename?: (from: string, to: string) => void;
};

function statDevice(path: string, move: DirectoryMovePlan, stat: (path: string) => StatLike): number {
  try {
    return stat(path).dev;
  } catch (err) {
    throw new ClientSwitchFilesystemError(
      `cannot stat ${path} for client switch move ${move.name}: ${err instanceof Error ? err.message : String(err)}`,
      move,
    );
  }
}

export function assertSameDeviceMove(move: DirectoryMovePlan, deps: RenameDeps = {}): void {
  const stat = deps.stat ?? statSync;
  const fromDev = statDevice(move.from, move, stat);
  const targetParent = dirname(move.to);
  const toParentDev = statDevice(targetParent, move, stat);
  if (fromDev !== toParentDev) {
    throw new ClientSwitchFilesystemError(
      `client switch move ${move.name} crosses devices (${move.from} dev=${fromDev}, ${targetParent} dev=${toParentDev}); refusing implicit copy`,
      move,
      "EXDEV",
    );
  }
}

export function assertSameDeviceMovePlan(moves: readonly DirectoryMovePlan[], deps: RenameDeps = {}): void {
  for (const move of moves) assertSameDeviceMove(move, deps);
}

export function renameSameDeviceDirectory(move: DirectoryMovePlan, deps: RenameDeps = {}): void {
  assertSameDeviceMove(move, deps);
  const rename = deps.rename ?? renameSync;
  try {
    rename(move.from, move.to);
  } catch (err) {
    const code = typeof err === "object" && err && "code" in err ? String((err as { code?: unknown }).code) : undefined;
    if (code === "EXDEV") {
      throw new ClientSwitchFilesystemError(
        `client switch move ${move.name} crossed devices during rename; refusing implicit copy`,
        move,
        "EXDEV",
      );
    }
    throw err;
  }
}
