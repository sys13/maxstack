// Export all types
export * from './types.js'

// Export utility functions for runtime usage
export {
	copyDirRecursive,
	generateConfigTemplate,
	generateTypesContent,
	toKebabCase,
	updateFileWithReplacements,
} from './utils.js'

// Re-export commonly used types as named exports for convenience
export type {
	MAXConfig,
	StandardFeature,
	Persona,
	Feature,
	Page,
	Model,
	Task,
	Priority,
	Status,
} from './types.js'
