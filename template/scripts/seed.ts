#!/usr/bin/env tsx

import { faker } from "@faker-js/faker";
import { createId } from "@paralleldrive/cuid2";
import { drizzle } from "drizzle-orm/libsql";
import { auth } from "../app/lib/auth.server";
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

	try {
		// Set a consistent seed for reproducible results
		faker.seed(12345);

		await clearDatabase();

		console.log("📊 Generating seed data...");

		// Generate Users
		console.log("👥 Creating users...");

		// Create demo user using Better Auth first
		console.log("🔐 Creating demo user account with password...");
		let demoUser: {
			id: string;
			name: string;
			email: string;
			emailVerified: boolean;
			image: string | null;
			createdAt: Date;
			updatedAt: Date;
		};
		let demoUserCreatedByAuth = false;
		try {
			const result = await auth.api.signUpEmail({
				body: {
					email: "demo@demo.com",
					password: "demo1234",
					name: "Demo User",
				},
			});
			demoUser = {
				id: result.user.id,
				name: result.user.name,
				email: result.user.email,
				emailVerified: result.user.emailVerified,
				image: result.user.image || null,
				createdAt: new Date(result.user.createdAt),
				updatedAt: new Date(result.user.updatedAt),
			};
			demoUserCreatedByAuth = true;
			console.log("Demo user created successfully");

			// Email verification is handled automatically by better-auth
		} catch (error) {
			console.error("Failed to create demo user:", error);
			// Create a fallback demo user without auth
			demoUser = {
				id: createId(),
				name: "Demo User",
				email: "demo@demo.com",
				emailVerified: true,
				image:
					"https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=150&h=150&fit=crop&crop=face",
				createdAt: new Date(),
				updatedAt: new Date(),
			};
		}

		const users = demoUserCreatedByAuth ? [] : [demoUser];

		// Generate additional random users
		for (let i = 0; i < 24; i++) {
			const userId = createId();
			const user = {
				id: userId,
				name: faker.person.fullName(),
				email: faker.internet.email(),
				emailVerified: Math.random() < 0.8, // 80% verified
				image: Math.random() < 0.7 ? faker.image.avatar() : null,
				createdAt: new Date(),
				updatedAt: new Date(),
			};
			users.push(user);
		}
		if (users.length > 0) {
			await db.insert(schema.user).values(users);
		}

		// Add demo user to users array for generating related data
		const allUsers = [demoUser, ...users];

		console.log("✅ Database seeding completed successfully!");
		console.log("📈 Generated:");
		console.log(
			`  - ${allUsers.length} users (including demo user: demo@demo.com)`,
		);
		console.log("");
		console.log("🎯 Demo User Credentials:");
		console.log("   Email: demo@demo.com");
		console.log("   Password: demo1234");
	} catch (error) {
		console.error("❌ Error during seeding:", error);
		process.exit(1);
	}
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
