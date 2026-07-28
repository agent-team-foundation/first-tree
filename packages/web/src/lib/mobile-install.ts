export const MOBILE_INSTALL_SOURCES = ["start_chat", "user_menu", "direct"] as const;

export type MobileInstallSource = (typeof MOBILE_INSTALL_SOURCES)[number];
export type MobilePromotionSource = Exclude<MobileInstallSource, "direct">;

export function buildMobileInstallUrl(origin: string, source: MobileInstallSource): string {
  const relative = source === "direct" ? "/m/install" : `/m/install?source=${source}`;
  const originMatch = /^(https?:\/\/[^/]+)/.exec(origin);
  return originMatch ? `${originMatch[1]}${relative}` : relative;
}

export function readMobileInstallSource(value: string | null): MobileInstallSource {
  if (value === "start_chat" || value === "user_menu") return value;
  return "direct";
}
