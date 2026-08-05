/**
 * Live preview — actually RUN the generated app code, not just show its source.
 *
 * The ownership `page` generator emits real modules (a route component + the
 * user-owned slot file). This renders them the way the app would: transpile the
 * emitted TSX (via the TypeScript compiler ts-morph already ships), evaluate the
 * modules with their real imports (`@maxstack/ui`'s `<Slot>` runtime, the
 * evaluated slot module, React's jsx-runtime), and render the page component to
 * static HTML. So the preview pane shows what the generated page *renders* —
 * including whatever the user's slot file contributes — with zero drift risk:
 * there is no interpreter to fall out of sync with the generator, the emitted
 * code itself is what runs.
 *
 * Server-only, and deliberately confined to generator output: this evaluates
 * the platform's own emitted modules for preview, not arbitrary user input.
 */

import * as maxstackUi from '@maxstack/ui'
import { createElement } from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import { ts } from 'ts-morph'

/** A generated artifact, as the generator runner returns it. */
export interface PreviewArtifact {
	path: string
	content: string
}

export type RenderedPreview =
	| { html: string; error: null }
	| { html: null; error: string }

const COMPILER_OPTIONS: import('ts-morph').ts.CompilerOptions = {
	module: ts.ModuleKind.CommonJS,
	target: ts.ScriptTarget.ES2022,
	jsx: ts.JsxEmit.ReactJSX,
	jsxImportSource: 'react',
	esModuleInterop: true,
}

type RequireShim = (spec: string) => unknown

/** Transpile one emitted TSX module and evaluate it as CommonJS. */
function evaluateModule(
	source: string,
	fileName: string,
	requireShim: RequireShim,
): Record<string, unknown> {
	const js = ts.transpileModule(source, {
		compilerOptions: COMPILER_OPTIONS,
		fileName,
	}).outputText
	const module = { exports: {} as Record<string, unknown> }
	// The generated code is the platform's own emitted module; evaluating it is
	// exactly what the app's bundler would do with the same file.
	new Function('require', 'module', 'exports', js)(
		requireShim,
		module,
		module.exports,
	)
	return module.exports
}

/**
 * Render the `page` generator's artifacts to static HTML — the generated route
 * module composed with its user-owned slot module, through the real `<Slot>`
 * runtime. Returns an error (never throws) so a broken emission degrades to a
 * message in the pane instead of a 500.
 */
export function renderGeneratedPage(
	artifacts: readonly PreviewArtifact[],
): RenderedPreview {
	try {
		const route = artifacts.find(
			(a) =>
				/^routes\/[^/]+\.tsx$/.test(a.path) && !a.path.endsWith('.slots.tsx'),
		)
		if (!route) return { html: null, error: 'No generated route module found.' }
		const slots = artifacts.find((a) => a.path.endsWith('.slots.tsx'))

		const baseRequire: RequireShim = (spec) => {
			if (spec === 'react/jsx-runtime') return jsxRuntime
			if (spec === '@maxstack/ui') return maxstackUi
			throw new Error(`Preview cannot resolve import "${spec}"`)
		}

		const slotsExports = slots
			? evaluateModule(slots.content, slots.path, baseRequire)
			: {}

		const routeExports = evaluateModule(route.content, route.path, (spec) => {
			// The route imports its slot file by relative specifier
			// (`./<resource>.slots.tsx`); hand it the evaluated module.
			if (spec.endsWith('.slots.tsx')) return slotsExports
			return baseRequire(spec)
		})

		const page = routeExports.default
		if (typeof page !== 'function')
			return { html: null, error: 'Generated module has no page component.' }
		return {
			html: renderToStaticMarkup(createElement(page as React.ComponentType)),
			error: null,
		}
	} catch (err) {
		return {
			html: null,
			error: err instanceof Error ? err.message : String(err),
		}
	}
}
