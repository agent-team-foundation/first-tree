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

export const connectTokenExchangeSchema = z.object({
  token: z.string().min(1),
});
export type ConnectTokenExchange = z.infer<typeof connectTokenExchangeSchema>;

export const connectTokenResponseSchema = z.object({
  token: z.string(),
  expiresIn: z.number(),
  command: z.string(),
});
export type ConnectTokenResponse = z.infer<typeof connectTokenResponseSchema>;
