export type ServiceState = "active" | "inactive" | "not-installed" | "unknown";

export type ServiceInfo = {
  platform: "launchd" | "systemd" | "task-scheduler" | "unsupported";
  label: string;
  unitPath: string;
  logDir: string;
  state: ServiceState;
  /** PID of the active service process, if running. */
  pid?: number;
  /** systemd manager scope when platform === "systemd". */
  managerScope?: "user" | "system";
  detail?: string;
};

/** Result of a start / stop / restart call against the service manager. */
export type ServiceOpResult = { ok: true; detail?: string } | { ok: false; reason: string };

export type ResolvedBinary = { kind: "bin"; program: string } | { kind: "node"; program: string; args: string[] };

export type SupervisorBackend = {
  platform: ServiceInfo["platform"];
  isSupported(): boolean;
  install(): ServiceInfo;
  refreshForUpdate(): ServiceInfo;
  isUnitDriftDetected(): boolean;
  status(): ServiceInfo;
  start(): ServiceOpResult;
  stop(): ServiceOpResult;
  restart(): ServiceOpResult;
  uninstall(): ServiceInfo;
};
