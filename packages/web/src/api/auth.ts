import type { LoginResponse } from "@first-tree/shared";
import { anonymousApi } from "./anonymous-client.js";

export async function login(username: string, password: string): Promise<LoginResponse> {
  return anonymousApi.post<LoginResponse>("/auth/login", { username, password });
}
