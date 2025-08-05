export const seed = `#!/usr/bin/env tsx

import { faker } from '@faker-js/faker'
import { createId } from '@paralleldrive/cuid2'
import {
	blogComment,
	category,
	post,
	postCategory,
	postTag,
	tag,
} from 'database/blog/schema'
import { user } from 'database/main/schema'
import { db } from '~/utils/db.server'

async function clearBlogData() {
	console.log('🗑️ Clearing existing blog data...')

	await db.delete(blogComment)
	await db.delete(postCategory)
	await db.delete(postTag)
	await db.delete(post)
	await db.delete(category)
	await db.delete(tag)
}

export default async function seed() {
	console.log('📝 Starting blog seeding...')

	try {
		// Set a consistent seed for reproducible results
		faker.seed(12345)

		await clearBlogData()

		console.log('📊 Generating blog seed data...')

		// Get existing users to use as authors
		const existingUsers = await db.select().from(user).limit(10)
		if (existingUsers.length === 0) {
			throw new Error('No users found! Please run the main seed script first.')
		}

		// Create categories
		console.log('� Creating categories...')
		const categories = [
			{ id: createId(), name: 'Technology' },
			{ id: createId(), name: 'Lifestyle' },
			{ id: createId(), name: 'Travel' },
			{ id: createId(), name: 'Food' },
			{ id: createId(), name: 'Business' },
			{ id: createId(), name: 'Health' },
			{ id: createId(), name: 'Education' },
			{ id: createId(), name: 'Entertainment' },
		]
		await db.insert(category).values(categories)

		// Create tags
		console.log('🏷️ Creating tags...')
		const tags = [
			{ id: createId(), name: 'React' },
			{ id: createId(), name: 'TypeScript' },
			{ id: createId(), name: 'JavaScript' },
			{ id: createId(), name: 'Web Development' },
			{ id: createId(), name: 'Tutorial' },
			{ id: createId(), name: 'Tips' },
			{ id: createId(), name: 'Review' },
			{ id: createId(), name: 'Guide' },
			{ id: createId(), name: 'News' },
			{ id: createId(), name: 'Opinion' },
			{ id: createId(), name: 'Adventure' },
			{ id: createId(), name: 'Recipe' },
			{ id: createId(), name: 'Fitness' },
			{ id: createId(), name: 'Productivity' },
			{ id: createId(), name: 'Startup' },
		]
		await db.insert(tag).values(tags)

		// Create blog posts
		console.log('📄 Creating blog posts...')
		const posts = []
		const postCategories = []
		const postTags = []

		for (let i = 0; i < 50; i++) {
			const postId = createId()
			const author = faker.helpers.arrayElement(existingUsers)
			const title = faker.lorem.sentence({ min: 3, max: 8 })
			const slug = faker.helpers.slugify(title).toLowerCase()

			// Generate realistic blog content
			const paragraphs = faker.number.int({ min: 3, max: 8 })
			let content = \`# \${title}\n\n\`

			for (let p = 0; p < paragraphs; p++) {
				content += \`\${faker.lorem.paragraphs(faker.number.int({ min: 2, max: 4 }), '\n\n')}\n\n\`

				// Occasionally add headers or lists
				if (Math.random() < 0.3) {
					content += \`## \${faker.lorem.sentence({ min: 2, max: 5 })}\n\n\`
				}
				if (Math.random() < 0.2) {
					content += '### Key Points:\n\n'
					for (let j = 0; j < faker.number.int({ min: 2, max: 5 }); j++) {
						content += \`- \${faker.lorem.sentence()}\n\`
					}
					content += '\n'
				}
			}

			const post = {
				id: postId,
				authorId: author.id,
				title,
				slug: \`\${slug}-\${i}\`, // Ensure uniqueness
				content,
				createdAt: new Date(
					Date.now() -
						faker.number.int({ min: 0, max: 30 * 24 * 60 * 60 * 1000 }),
				), // Last 30 days
				updatedAt: new Date(),
			}
			posts.push(post)

			// Assign 1-3 categories to each post
			const numCategories = faker.number.int({ min: 1, max: 3 })
			const selectedCategories = faker.helpers.arrayElements(
				categories,
				numCategories,
			)
			for (const cat of selectedCategories) {
				postCategories.push({
					postId,
					categoryId: cat.id,
				})
			}

			// Assign 2-6 tags to each post
			const numTags = faker.number.int({ min: 2, max: 6 })
			const selectedTags = faker.helpers.arrayElements(tags, numTags)
			for (const tagItem of selectedTags) {
				postTags.push({
					postId,
					tagId: tagItem.id,
				})
			}
		}

		await db.insert(post).values(posts)
		await db.insert(postCategory).values(postCategories)
		await db.insert(postTag).values(postTags)

		// Create blog comments
		console.log('💬 Creating blog comments...')
		const comments: Array<{
			id: string
			content: string
			postId: string
			userId: string
			parentId: string | null
			createdAt: Date
			updatedAt: Date
		}> = []

		for (let i = 0; i < 200; i++) {
			const selectedPost = faker.helpers.arrayElement(posts)
			const commenter = faker.helpers.arrayElement(existingUsers)

			// 20% chance of being a reply to an existing comment
			let parentId: string | null = null
			if (Math.random() < 0.2) {
				const existingComments = comments.filter(
					(c) => c.postId === selectedPost.id,
				)
				if (existingComments.length > 0) {
					parentId = faker.helpers.arrayElement(existingComments).id
				}
			}

			const comment = {
				id: createId(),
				content: faker.lorem.paragraphs(faker.number.int({ min: 1, max: 3 })),
				postId: selectedPost.id,
				userId: commenter.id,
				parentId,
				createdAt: new Date(
					Date.now() -
						faker.number.int({ min: 0, max: 7 * 24 * 60 * 60 * 1000 }),
				), // Last 7 days
				updatedAt: new Date(),
			}
			comments.push(comment)
		}

		await db.insert(blogComment).values(comments)

		console.log('✅ Blog seeding completed successfully!')
		console.log('📈 Generated:')
		console.log(\`  - \${categories.length} categories\`)
		console.log(\`  - \${tags.length} tags\`)
		console.log(\`  - \${posts.length} blog posts\`)
		console.log(\`  - \${postCategories.length} post-category relationships\`)
		console.log(\`  - \${postTags.length} post-tag relationships\`)
		console.log(\`  - \${comments.length} comments\`)
	} catch (error) {
		console.error('❌ Error during blog seeding:', error)
		throw error
	}
}

// Run the seed script if called directly
if (import.meta.url === \`file://\${process.argv[1]}\`) {
	seed()
		.then(() => process.exit(0))
		.catch((error) => {
			console.error('Fatal error:', error)
			process.exit(1)
		})
}
`
