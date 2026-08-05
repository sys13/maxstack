/**
 * Email template registry — the salvaged decision from mxscratchpad's
 * `emails/registry.ts`: a name-keyed store where custom templates override
 * defaults of the same name.
 *
 * Reimplementation notes (reference spec: `docs/reference-specs/email-registry.md`):
 * the original was a static-only class over two module-level record objects —
 * a shared global the original's own test had to `beforeEach`-reset by
 * reaching into private state. This staging keeps the exact API surface
 * (`register`/`get`/`has`/`getAll`/`remove`/`getTemplateNames`) but makes it an
 * instantiable class seeded from `defaultTemplates`, so each consumer (and each
 * test) gets isolated state. A shared `emailRegistry` singleton preserves the
 * original's convenience of a process-wide default registry.
 */

import { defaultTemplates } from './templates.ts'
import type { EmailTemplate } from './types.ts'

export class EmailRegistry {
	readonly #defaults: Record<string, EmailTemplate<any>>
	#custom: Record<string, EmailTemplate<any>> = {}

	constructor(defaults: Record<string, EmailTemplate<any>> = defaultTemplates) {
		this.#defaults = { ...defaults }
	}

	/** Register a custom template or override an existing one by name. */
	register(template: EmailTemplate): void {
		this.#custom[template.name] = template
	}

	/** Get a template by name; custom templates take precedence over defaults. */
	get(name: string): EmailTemplate | undefined {
		return this.#custom[name] ?? this.#defaults[name]
	}

	/** All templates, with custom overriding default on name collision. */
	getAll(): Record<string, EmailTemplate> {
		return { ...this.#defaults, ...this.#custom }
	}

	/** Whether a template exists under `name`. */
	has(name: string): boolean {
		return name in this.#custom || name in this.#defaults
	}

	/** Remove a custom template; reverts to the default if one exists. Returns whether a custom template was removed. */
	remove(name: string): boolean {
		if (name in this.#custom) {
			delete this.#custom[name]
			return true
		}
		return false
	}

	/** All known template names (defaults + custom). */
	getTemplateNames(): string[] {
		return Object.keys(this.getAll())
	}
}

/** Process-wide default registry (preserves the original's module-global default). */
export const emailRegistry = new EmailRegistry()
