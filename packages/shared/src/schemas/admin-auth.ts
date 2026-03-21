import { z } from "zod";

export const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
export type Login = z.infer<typeof loginSchema>;

export const loginResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
});
export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshToken = z.infer<typeof refreshTokenSchema>;

export const ADMIN_ROLES = {
  SUPER_ADMIN: "super_admin",
  ADMIN: "admin",
} as const;

export const adminRoleSchema = z.enum(["super_admin", "admin"]);
export type AdminRole = z.infer<typeof adminRoleSchema>;

export const adminUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  role: adminRoleSchema,
  createdAt: z.string(),
  lastLoginAt: z.string().nullable(),
});
export type AdminUser = z.infer<typeof adminUserSchema>;
