import { channelConfig } from "../channel.js";
import { logDir } from "./shared.js";
import type { ServiceInfo, ServiceOpResult, SupervisorBackend } from "./types.js";

function unsupportedStatus(): ServiceInfo {
  return {
    platform: "unsupported",
    label: "",
    unitPath: "",
    logDir: logDir(),
    state: "not-installed",
    detail: `platform ${process.platform} not supported`,
  };
}

function unsupportedServiceControl(): ServiceOpResult {
  return { ok: false, reason: `service control not supported on ${process.platform}` };
}

export const unsupportedBackend: SupervisorBackend = {
  platform: "unsupported",
  isSupported: () => false,
  install: () => {
    throw new Error(
      `Background service install is not supported on ${process.platform}. ` +
        `Run \`${channelConfig.binName} daemon start\` manually to keep the computer online.`,
    );
  },
  refreshForUpdate: () => {
    throw new Error(
      `Background service refresh is not supported on ${process.platform}. ` +
        `Run \`${channelConfig.binName} daemon start\` manually to keep the computer online.`,
    );
  },
  isUnitDriftDetected: () => false,
  status: unsupportedStatus,
  start: unsupportedServiceControl,
  stop: unsupportedServiceControl,
  restart: unsupportedServiceControl,
  uninstall: unsupportedStatus,
};
