import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    // eslint-disable-next-line -- drizzle-kit requires this at config level
    url: process.env.DATABASE_URL ?? "",
  },
});
