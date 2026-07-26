import type { ServiceInfo } from "./service-install.js";

export function shouldRestartServiceAfterRefresh(service: ServiceInfo): boolean {
  if (service.state === "active") return true;
  if (service.platform !== "task-scheduler" || service.state !== "unknown") return false;
  const detail = (service.detail ?? "").toLowerCase();
  return (
    detail.includes("task running") ||
    detail.includes("service runtime marker is live") ||
    detail.includes("supervisor process is still live")
  );
}
