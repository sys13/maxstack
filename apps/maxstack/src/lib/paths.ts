/**
 * The two absolute paths the CLI resolves against itself.
 *
 * Both are computed from this module's own URL rather than `process.cwd()`, so
 * they mean the same thing however the CLI was invoked — a global install, a
 * `npx` run out of a cache dir, or a checkout.
 */

import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The CLI package root — two levels up from `src/lib/`.
 *
 * Used to reach files that ship *inside* the package: the project templates
 * `init` renders, and the `package.json` the version checks read. Under an npm
 * install this is a read-only `node_modules/maxstack`, which is why nothing
 * writes here.
 */
export const HUB_ROOT = resolve(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'..',
)

/**
 * The user's own maxstack dir — a writable home for per-user state that must
 * survive reinstalls. It is deliberately *not* under {@link HUB_ROOT}: `npm
 * install` replaces that directory wholesale, so anything cached there would
 * silently vanish on the next upgrade.
 */
export const USER_CONFIG_DIR = resolve(homedir(), '.maxstack')
