import { z } from "zod";
import { adminRoleSchema } from "./admin-auth.js";

export const createAdminUserSchema = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(8).max(200),
  role: adminRoleSchema.default("admin"),
});
export type CreateAdminUser = z.infer<typeof createAdminUserSchema>;

export const updateAdminUserSchema = z.object({
  role: adminRoleSchema.optional(),
  password: z.string().min(8).max(200).optional(),
});
export type UpdateAdminUser = z.infer<typeof updateAdminUserSchema>;
