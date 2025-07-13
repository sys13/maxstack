import type { Config } from "drizzle-kit";

export default {
	out: "./drizzle",
	schema: "./database/schema.ts",
	dialect: "sqlite",
	casing: "snake_case",
	dbCredentials: {
		url: process.env.DB_FILE_NAME ?? "file:./local.db",
	},
} satisfies Config;
