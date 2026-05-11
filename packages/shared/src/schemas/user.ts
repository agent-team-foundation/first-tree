import { z } from "zod";

export const USER_STATUSES = {
  ACTIVE: "active",
  SUSPENDED: "suspended",
} as const;

export const userStatusSchema = z.enum(["active", "suspended"]);
export type UserStatus = z.infer<typeof userStatusSchema>;

export const userSchema = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  status: userStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type User = z.infer<typeof userSchema>;

export const createUserSchema = z.object({
  username: z.string().min(1).max(100),
  displayName: z.string().min(1).max(200),
  password: z.string().min(8).max(200),
});
export type CreateUser = z.infer<typeof createUserSchema>;

export const updateUserSchema = z.object({
  displayName: z.string().min(1).max(200).optional(),
  password: z.string().min(8).max(200).optional(),
});
export type UpdateUser = z.infer<typeof updateUserSchema>;
