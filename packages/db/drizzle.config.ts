import { defineConfig } from "drizzle-kit";
export default defineConfig({
  schema: "./dist/schema/index.js",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://voxi:voxi@localhost:5432/voxi" },
});
