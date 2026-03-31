import { decryptCredentials } from "../crypto.js";
import type { FeishuBotCredentials } from "./types.js";

const FEISHU_OPEN_API = "https://open.feishu.cn/open-apis";

/**
 * Get a tenant access token for a Feishu app.
 */
async function getTenantToken(appId: string, appSecret: string): Promise<string> {
  const res = await fetch(`${FEISHU_OPEN_API}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });

  if (!res.ok) {
    throw new Error(`Failed to get Feishu tenant token: ${res.status}`);
  }

  const data = (await res.json()) as { tenant_access_token?: string; code?: number; msg?: string };
  if (!data.tenant_access_token) {
    throw new Error(`Feishu auth failed: ${data.msg ?? "unknown error"}`);
  }

  return data.tenant_access_token;
}

export type FeishuUser = {
  userId: string;
  name: string;
  email: string | null;
  department: string | null;
};

/**
 * Search Feishu users by name/email/mobile using a bot's credentials.
 */
export async function searchFeishuUsers(
  credentials: FeishuBotCredentials,
  query: string,
  by: "name" | "email" | "mobile" = "name",
): Promise<FeishuUser[]> {
  const token = await getTenantToken(credentials.app_id, credentials.app_secret);

  // Use the search endpoint for name, or batch_get for email/mobile
  if (by === "name") {
    return searchByName(token, query);
  }
  if (by === "email") {
    return searchByEmail(token, query);
  }
  if (by === "mobile") {
    return searchByMobile(token, query);
  }
  return [];
}

async function searchByName(token: string, query: string): Promise<FeishuUser[]> {
  // Use contact/v3/users/find_by_department and filter by name,
  // or use search/v2 API with tenant token.
  // The /search/v1/user endpoint requires user_access_token (not tenant),
  // so we use /contact/v3/users with department_id=0 (root) to list and filter.
  const res = await fetch(
    `${FEISHU_OPEN_API}/contact/v3/users/find_by_department?department_id=0&page_size=50&user_id_type=open_id`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { code?: number; msg?: string };
    if (body.code === 99991672) {
      throw new Error(
        "Feishu bot missing contact permissions. " +
          "Enable 'contact:user.base:readonly' scope in Feishu admin console: " +
          `https://open.feishu.cn/app/${token.slice(0, 20)}`,
      );
    }
    throw new Error(`Feishu contact API error: ${res.status} - ${body.msg ?? ""}`);
  }

  type ContactResponse = {
    code: number;
    msg?: string;
    data?: {
      items?: Array<{
        open_id: string;
        name: string;
        email?: string;
        department_ids?: string[];
      }>;
    };
  };

  const data = (await res.json()) as ContactResponse;

  // Check business-level error code
  if (data.code !== 0) {
    if (data.code === 99991672) {
      throw new Error(
        "Feishu bot missing contact permissions. " +
          "Enable 'contact:user.base:readonly' scope in Feishu admin console.",
      );
    }
    throw new Error(`Feishu API error: ${data.code} - ${data.msg ?? ""}`);
  }

  if (!data.data?.items) return [];

  // Filter by query (case-insensitive substring match)
  const lowerQuery = query.toLowerCase();
  return data.data.items
    .filter((item) => item.name.toLowerCase().includes(lowerQuery))
    .map((item) => ({
      userId: item.open_id,
      name: item.name,
      email: item.email ?? null,
      department: null,
    }));
}

async function searchByEmail(token: string, email: string): Promise<FeishuUser[]> {
  const res = await fetch(`${FEISHU_OPEN_API}/contact/v3/users/batch_get_id`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ emails: [email] }),
  });

  if (!res.ok) {
    throw new Error(`Feishu contact API error: ${res.status}`);
  }

  type BatchResponse = {
    code: number;
    data?: {
      user_list?: Array<{
        user_id?: string;
        email?: string;
      }>;
    };
  };

  const data = (await res.json()) as BatchResponse;
  if (!data.data?.user_list) return [];

  return data.data.user_list
    .filter((u): u is typeof u & { user_id: string } => Boolean(u.user_id))
    .map((u) => ({
      userId: u.user_id,
      name: u.email ?? email,
      email: u.email ?? email,
      department: null,
    }));
}

async function searchByMobile(token: string, mobile: string): Promise<FeishuUser[]> {
  const res = await fetch(`${FEISHU_OPEN_API}/contact/v3/users/batch_get_id`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ mobiles: [mobile] }),
  });

  if (!res.ok) {
    throw new Error(`Feishu contact API error: ${res.status}`);
  }

  type BatchResponse = {
    code: number;
    data?: {
      user_list?: Array<{
        user_id?: string;
        mobile?: string;
      }>;
    };
  };

  const data = (await res.json()) as BatchResponse;
  if (!data.data?.user_list) return [];

  return data.data.user_list
    .filter((u): u is typeof u & { user_id: string } => Boolean(u.user_id))
    .map((u) => ({
      userId: u.user_id,
      name: mobile,
      email: null,
      department: null,
    }));
}

/**
 * Get decrypted Feishu bot credentials from an encrypted blob.
 */
export function decryptFeishuCredentials(encrypted: string, encryptionKey: string): FeishuBotCredentials {
  const decrypted = decryptCredentials(encrypted, encryptionKey);
  return decrypted as FeishuBotCredentials;
}
