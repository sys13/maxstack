import { eq } from 'drizzle-orm'
import { data, type ActionFunctionArgs } from 'react-router'
import { auth } from '~/lib/auth.server'
import { db } from '~/utils/db.server'
import { user } from '../../database/main/schema'

export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'DELETE') {
		throw new Response('Method not allowed', { status: 405 })
	}

	try {
		const session = await auth.api.getSession({ headers: request.headers })

		if (!session?.user?.id) {
			throw new Response('Unauthorized', { status: 401 })
		}

		const userId = session.user.id

		// Delete the user from the database
		// Due to cascade constraints, this will automatically delete:
		// - sessions, accounts, projects, tasks, blog posts, etc.
		await db.delete(user).where(eq(user.id, userId))

		return { success: true }
	} catch (error) {
		console.error('Error deleting user account:', error)
		return data(
			{ error: 'Failed to delete account. Please try again.' },
			{
				status: 500,
				headers: { 'Content-Type': 'application/json' },
			},
		)
	}
}
