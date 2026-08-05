/**
 * URL construction for the project surface — one function, no dependencies.
 *
 * Its own module rather than a `project-routes.ts` export because both sides of
 * the app build these URLs: the loaders (which may import anything) and the
 * client components that render the links (which may not). `project-routes.ts`
 * pulls in `@maxstack/core/ownership` and `@maxstack/spec`, so every client-side
 * import of it is deliberately `import type` — a *value* import would put that
 * graph in the browser bundle, which is how issue #251 shipped ts-morph to the
 * client and silently killed hydration. A leaf module both sides can import for
 * real keeps that property structural instead of remembered.
 */

/**
 * A URL under a page: `pagePath('decks', 'new')` → `/decks/new`.
 *
 * Every link, form target and redirect on the project surface goes through this
 * rather than interpolating `` `/${slug}/new` ``, because **the root page's slug
 * is the empty string**. Interpolating it yields `//new`, which a browser reads
 * as the protocol-relative URL `https://new/` — an off-site navigation, not a
 * broken in-app link. Joining the non-empty parts instead makes the root page's
 * create URL `/new`, which is what `matchProjectPath` resolves it back to.
 */
export const pagePath = (slug: string, ...rest: string[]): string =>
	`/${[slug, ...rest].filter((part) => part !== '').join('/')}`
