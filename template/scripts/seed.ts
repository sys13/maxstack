#!/usr/bin/env tsx

import { drizzle } from "drizzle-orm/libsql";
import * as schema from "../database/schema";

// Initialize database connection
const db = drizzle({
	// biome-ignore lint/style/noNonNullAssertion: has a default value
	connection: { url: process.env.DB_FILE_NAME! },
	casing: "snake_case",
});

async function clearDatabase() {
	console.log("🗑️ Clearing existing data...");

	await db.delete(schema.verification);
	await db.delete(schema.account);
	await db.delete(schema.session);
	await db.delete(schema.user);
}

async function main() {
	console.log("🌱 Starting database seeding...");

	// Set a consistent seed for reproducible results
	faker.seed(12345);

	await clearDatabase();

	console.log("📊 Generating seed data...");
}

// Run the seed script
if (import.meta.url === `file://${process.argv[1]}`) {
	main()
		.then(() => process.exit(0))
		.catch((error) => {
			console.error("Fatal error:", error);
			process.exit(1);
		});
}

export { main as seedDatabase };
