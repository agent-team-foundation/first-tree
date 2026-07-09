/**
 * Community / support destinations, shared by the onboarding finale
 * (CommunityBlock in step-start-chat.tsx) and the top-bar SupportMenu.
 */
export const DISCORD_INVITE_URL = "https://discord.gg/nCG9wsbbvF";

/**
 * Served from packages/web/public/.
 *
 * GOTCHA: WeChat group QRs EXPIRE — the group owner must re-export the QR
 * (WeChat → group → 群二维码) and replace this image before the printed
 * validity date, or scans start failing silently. Only this file needs to
 * change; both surfaces pick it up.
 */
export const WECHAT_QR_SRC = "/community/wechat-qr.png";
