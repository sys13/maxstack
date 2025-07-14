import { test } from '@playwright/test'

test('Landing page loads', async ({ page }) => {
	await page.goto('/')
})
