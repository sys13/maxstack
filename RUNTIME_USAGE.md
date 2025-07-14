# Runtime Usage for Web Applications

Maxstack now supports runtime usage in web applications! This means you can use maxstack as a dependency in your web app to access templates, types, and configuration utilities at runtime.

## Installation

```bash
npm install maxstack
```

## Usage

### Importing Types

```typescript
import type { MAXConfig, StandardFeature, Feature, Page } from 'maxstack'

const config: MAXConfig = {
	name: 'My Web App',
	description: 'A sample web application',
	standardFeatures: ['blog', 'user-authentication'] as StandardFeature[],
	pages: [
		{
			name: 'Home',
			description: 'Landing page',
			routePath: '/',
			components: ['Hero', 'Features', 'CTA'],
		},
		'About',
		'Contact',
	],
}
```

### Using Utility Functions

```typescript
import {
	generateConfigTemplate,
	toKebabCase,
	generateTypesContent,
} from 'maxstack'

// Generate configuration templates dynamically
const configTemplate = generateConfigTemplate(
	'default',
	'My App',
	'A sample app',
	['blog', 'user-authentication'],
)

// Convert strings to kebab-case
const slug = toKebabCase('My Project Name') // 'my-project-name'

// Generate TypeScript types dynamically
const typesContent = generateTypesContent()
```

## Available Exports

- **Types**: All MAXConfig types including `MAXConfig`, `StandardFeature`, `Feature`, `Page`, `Model`, etc.
- **Utilities**:
  - `generateConfigTemplate()` - Generate configuration templates
  - `generateTypesContent()` - Generate TypeScript type definitions
  - `toKebabCase()` - Convert strings to kebab-case
  - `copyDirRecursive()` - Copy directories recursively
  - `updateFileWithReplacements()` - Update files with placeholders

## Benefits

- **No embedded templates**: Web apps don't need to embed all template files directly
- **Type safety**: Full TypeScript support with comprehensive type definitions
- **Dynamic configuration**: Generate configurations and types at runtime
- **Reusable utilities**: Use the same utilities that the CLI uses

## Example

See the demo script in `demo/runtime-demo.js` for a complete example of how to use maxstack at runtime.
