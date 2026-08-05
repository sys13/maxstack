/**
 * The standard `clsx` + `tailwind-merge` classname helper. Pre-existing gap
 * fix, unrelated to this branch's feature work: `cn` has been imported from
 * `../lib/cn.ts` across the library
 * but the module itself was never committed, breaking `@maxstack/ui`'s
 * typecheck/build and every downstream package that depends on it (including
 * `@maxstack/web`, whose workbench tests this feature touches). `clsx` and
 * `tailwind-merge` are already declared dependencies of this package.
 */

import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
	return twMerge(clsx(inputs))
}
