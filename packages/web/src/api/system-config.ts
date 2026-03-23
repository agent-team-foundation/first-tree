import { api } from "./client.js";

export type ConfigMap = Record<string, unknown>;

export function getConfigs(): Promise<ConfigMap> {
  return api.get<ConfigMap>("/admin/system/config");
}

export function updateConfigs(configs: ConfigMap): Promise<ConfigMap> {
  return api.patch<ConfigMap>("/admin/system/config", configs);
}
