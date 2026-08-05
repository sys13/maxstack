/**
 * Critical-flow browser smoke: boots the production build
 * and exercises the paths a broken deploy would break first — liveness, the
 * auth entry point, and the reject-anonymous-credentials path. Two of these
 * are the security baseline's critical-path authz tests; keep them green and
 * deterministic (no seed data assumed).
 */

import { expect, test } from '@playwright/test'

test('health endpoint reports a reachable database', async ({ request }) => {
	const res = await request.get('/health')
	expect(res.status()).toBe(200)
	const body = await res.json()
	expect(body.status).toBe('ok')
	expect(body.db).toBe(true)
})

test('home page renders without a server error', async ({ page }) => {
	const response = await page.goto('/')
	expect(response, 'expected a navigation response').toBeTruthy()
	if (response) expect(response.status()).toBeLessThan(500)
	await expect(page.locator('body')).not.toBeEmpty()
})

test('login page renders the sign-in form', async ({ page }) => {
	await page.goto('/login')
	await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
	const signIn = page.locator('form:has(input[name="intent"][value="signIn"])')
	await expect(signIn.locator('input[name="email"]')).toBeVisible()
	await expect(signIn.locator('input[name="password"]')).toBeVisible()
})

// Security baseline authz test 1: anonymous credentials never mint a session.
test('bad credentials are rejected with an error and no session cookie', async ({
	page,
}) => {
	await page.goto('/login')
	const signIn = page.locator('form:has(input[name="intent"][value="signIn"])')
	await signIn.locator('input[name="email"]').fill('nobody@example.com')
	await signIn.locator('input[name="password"]').fill('definitely-wrong')
	await signIn.getByRole('button', { name: 'Sign in' }).click()
	await expect(page.getByRole('alert')).toBeVisible()
	const cookies = await page.context().cookies()
	expect(cookies.filter((c) => c.name.includes('session'))).toHaveLength(0)
})

// Security baseline authz test 2: the auth session endpoint holds no
// principal for an anonymous browser (better-auth wiring intact).
test('anonymous session lookup returns no principal', async ({ request }) => {
	const res = await request.get('/api/auth/get-session')
	expect(res.status()).toBe(200)
	const body = await res.text()
	expect(['null', '']).toContain(body.trim())
})
