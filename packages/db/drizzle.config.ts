import type { Config } from "drizzle-kit";

export default {
  schema: "./src/schema.ts",
  dialect: "turso",
  out: "./drizzle",
  verbose: true,
  strict: true,
} satisfies Config;
