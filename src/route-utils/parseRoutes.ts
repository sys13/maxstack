import {
	ModuleKind,
	ModuleResolutionKind,
	type Node,
	Project,
	ScriptTarget,
	SyntaxKind,
} from 'ts-morph'

interface ParsedRoute {
	filePath: string
	layout?: string
	route: string
}

// https://reactrouter.com/api/framework-conventions/routes.ts
// route should be parsed as a route with the given path
// index should be parsed as if it were a route with /
// layout should be noted as a component that wraps other routes
// prefix should prefix all routes in a specific path
// `import { index, route, type RouteConfig, } from '@react-router/dev/routes'

// export default [
// 	index('routes/home.tsx'),
// 	route('*', './catchall.tsx'),
// 	route('/api/auth/*', 'routes/auth-handler.ts'),
// 	route('/healthcheck', 'routes/healthcheck.tsx'),
// 	route('/login', 'routes/login.tsx'),
// 	route('/signup', 'routes/signup.tsx'),
// 	route('/verify-email', 'routes/verify-email.tsx'),
// 	route('/forgot-password', 'routes/forgot-password.tsx'),
// 	route('/reset-password', 'routes/reset-password.tsx'),
// ] satisfies RouteConfig
// `
export function parseRoutes(routesFileContent: string): ParsedRoute[] {
	const project = new Project({
		compilerOptions: {
			allowSyntheticDefaultImports: true,
			esModuleInterop: true,
			module: ModuleKind.ESNext,
			moduleResolution: ModuleResolutionKind.Node10,
			skipLibCheck: true,
			target: ScriptTarget.ES2020,
		},
		useInMemoryFileSystem: true,
	})

	const sourceFile = project.createSourceFile('routes.ts', routesFileContent)
	const routes: ParsedRoute[] = []

	function parseRouteElement(
		element: Node,
		pathPrefix = '',
		currentLayout?: string,
	): void {
		const kind = element.getKind()

		// Handle CallExpression (route(), index(), layout(), prefix())
		if (kind === SyntaxKind.CallExpression) {
			const callExpression = element.asKindOrThrow(SyntaxKind.CallExpression)
			const expression = callExpression.getExpression()

			if (expression.getKind() !== SyntaxKind.Identifier) {
				return
			}

			const functionName = expression.getText()
			const args = callExpression.getArguments()

			if (functionName === 'route' && args.length >= 2) {
				const path = args[0].getText().replace(/['"]/g, '')
				const filePath = args[1].getText().replace(/['"]/g, '')
				const fullPath = pathPrefix
					? `/${pathPrefix}${path === '/' ? '' : `/${path}`}`
					: path

				const route: ParsedRoute = {
					filePath,
					route:
						fullPath.startsWith('/') || fullPath === '*'
							? fullPath
							: `/${fullPath}`,
				}

				if (currentLayout) {
					route.layout = currentLayout
				}

				routes.push(route)
			} else if (functionName === 'index' && args.length >= 1) {
				const filePath = args[0].getText().replace(/['"]/g, '')
				const fullPath = pathPrefix ? `/${pathPrefix}` : '/'

				const route: ParsedRoute = {
					filePath,
					route: fullPath,
				}

				if (currentLayout) {
					route.layout = currentLayout
				}

				routes.push(route)
			} else if (functionName === 'layout' && args.length >= 2) {
				const layoutFile = args[0].getText().replace(/['"]/g, '')
				const childrenArg = args[1]

				if (childrenArg.getKind() === SyntaxKind.ArrayLiteralExpression) {
					const arrayLiteral = childrenArg.asKindOrThrow(
						SyntaxKind.ArrayLiteralExpression,
					)
					const children = arrayLiteral.getElements()
					for (const child of children) {
						parseRouteElement(child, pathPrefix, layoutFile)
					}
				}
			} else if (functionName === 'prefix' && args.length >= 2) {
				const prefixPath = args[0].getText().replace(/['"]/g, '')
				const childrenArg = args[1]

				if (childrenArg.getKind() === SyntaxKind.ArrayLiteralExpression) {
					const arrayLiteral = childrenArg.asKindOrThrow(
						SyntaxKind.ArrayLiteralExpression,
					)
					const children = arrayLiteral.getElements()
					for (const child of children) {
						parseRouteElement(child, prefixPath, currentLayout)
					}
				}
			}
		}
		// Handle SpreadElement (...prefix())
		else if (kind === SyntaxKind.SpreadElement) {
			const spreadElement = element.asKindOrThrow(SyntaxKind.SpreadElement)
			const expression = spreadElement.getExpression()
			if (expression.getKind() === SyntaxKind.CallExpression) {
				parseRouteElement(expression, pathPrefix, currentLayout)
			}
		}
		// Handle ArrayLiteralExpression
		else if (kind === SyntaxKind.ArrayLiteralExpression) {
			const arrayLiteral = element.asKindOrThrow(
				SyntaxKind.ArrayLiteralExpression,
			)
			const elements = arrayLiteral.getElements()
			for (const child of elements) {
				parseRouteElement(child, pathPrefix, currentLayout)
			}
		}
	}

	// Find the export assignments (both export = and export default)
	const exportAssignments = sourceFile.getExportAssignments()

	for (const exportAssignment of exportAssignments) {
		let expression = exportAssignment.getExpression()

		// Handle "satisfies" type assertions (e.g., "[] satisfies RouteConfig")
		if (expression.getKind() === SyntaxKind.TypeAssertionExpression) {
			const typeAssertion = expression.asKindOrThrow(
				SyntaxKind.TypeAssertionExpression,
			)
			expression = typeAssertion.getExpression()
		} else if (expression.getKind() === SyntaxKind.AsExpression) {
			const asExpression = expression.asKindOrThrow(SyntaxKind.AsExpression)
			expression = asExpression.getExpression()
		} else if (expression.getKind() === SyntaxKind.SatisfiesExpression) {
			const satisfiesExpression = expression.asKindOrThrow(
				SyntaxKind.SatisfiesExpression,
			)
			expression = satisfiesExpression.getExpression()
		}

		if (expression.getKind() === SyntaxKind.ArrayLiteralExpression) {
			const arrayLiteral = expression.asKindOrThrow(
				SyntaxKind.ArrayLiteralExpression,
			)
			const elements = arrayLiteral.getElements()
			for (const element of elements) {
				parseRouteElement(element)
			}
			break
		}
	}

	return routes
}
