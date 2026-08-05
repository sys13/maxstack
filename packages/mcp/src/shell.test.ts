import { newSpecSystem, type SpecSystem } from '@maxstack/spec'
import { tasklyPRD } from '@maxstack/spec/fixtures'
import { describe, expect, it } from 'vitest'
import { createCheckRegistry, specValidateCheck } from './checks.ts'
import { shellCheck, shellGenerator } from './shell.ts'

const spec: SpecSystem = newSpecSystem(tasklyPRD)

describe('shellCheck', () => {
	it('passes when the command exits 0 and captures its output', async () => {
		const check = shellCheck('echo', 'says hi', 'echo hello-from-check')
		const [res] = await createCheckRegistry([check]).run(spec, ['echo'])
		expect(res?.ok).toBe(true)
		expect(res?.output).toContain('hello-from-check')
	})

	it('fails when the command exits non-zero, surfacing output', async () => {
		const check = shellCheck('boom', 'always fails', 'echo nope 1>&2; exit 3')
		const [res] = await createCheckRegistry([check]).run(spec, ['boom'])
		expect(res?.ok).toBe(false)
		expect(res?.output).toContain('nope')
	})

	it('composes with the pure spec-validate gate', async () => {
		const runner = createCheckRegistry([
			specValidateCheck,
			shellCheck('typecheck', 'tsc --noEmit', 'exit 0'),
		])
		const results = await runner.run(spec)
		expect(results.map((r) => r.name).sort()).toEqual([
			'spec-validate',
			'typecheck',
		])
		expect(results.every((r) => r.ok)).toBe(true)
	})
})

describe('shellGenerator', () => {
	it('runs the command and reports its output as a note', async () => {
		const gen = shellGenerator(
			'codegen',
			'writes files',
			'echo generated 3 files',
		)
		const res = await gen.run(spec, {})
		expect(res.artifacts).toEqual([])
		expect(res.notes[0]).toContain('generated 3 files')
	})

	it('throws with the captured output when the command fails', async () => {
		const gen = shellGenerator(
			'codegen',
			'writes files',
			'echo bad 1>&2; exit 1',
		)
		await expect(gen.run(spec, {})).rejects.toThrow(/bad/)
	})
})
