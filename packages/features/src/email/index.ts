/**
 * Email feature — a name-keyed template registry (custom overrides default)
 * plus four default templates, staged from mxscratchpad. See
 * `docs/reference-specs/email-registry.md`.
 */

export * from './mailer.ts'
export { EmailRegistry, emailRegistry } from './registry.ts'
export * from './templates.ts'
export * from './types.ts'
