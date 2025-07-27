export const templates = {
	blogLanding: {
		importsText: `import { db } from '~/utils/db.server'
import { invariantResponse } from '~/utils/invariant'`,
		loaderText: `export async function loader({ params }: Route.LoaderArgs) {
	const { slug } = params
	invariantResponse(slug, 'Post ID is required')

	const post = await db.query.post
		.findFirst({
			where: { slug },
			with: { author: { columns: { name: true } } },
		})
		.then((post) => {
			invariantResponse(post, \`Post '\${slug}' not found\`)
			return { ...post, author: post.author?.name }
		})

	return { post }
}`,
	},
	blogPost: {
		importsText: `import { db } from '~/utils/db.server'`,
		loaderText: `export async function loader({}: Route.LoaderArgs) {
	const posts = (
		await db.query.post.findMany({
			with: { author: { columns: { name: true } } },
		})
	).map((post) => ({
		...post,
		author: post.author?.name || null,
	}))

	return {
		posts,
	}
}`,
	},
}
