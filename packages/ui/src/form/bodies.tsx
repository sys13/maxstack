/** Section / wizard chrome for `<DynamicForm>` — the sectioned (panels / tabs /
 * accordion) and wizard body layouts. */

import { useState } from 'react'
import { cn } from '../lib/cn.ts'
import { Button } from '../ui/primitives.tsx'
import type { ResolvedSection } from './field-tree.ts'
import type { SectionVariant } from './types.ts'

export interface BodyProps {
	sections: ResolvedSection[]
	renderFields: (section: ResolvedSection) => React.ReactNode
}

export function SectionedBody({
	sections,
	variant,
	renderFields,
	footer,
}: BodyProps & { variant: SectionVariant; footer: React.ReactNode }) {
	const [active, setActive] = useState(0)
	const activeSection = sections[active] ?? sections[0]

	if (variant === 'tabs' && activeSection) {
		return (
			<div className="space-y-4">
				<div role="tablist" className="flex gap-1 border-b border-input">
					{sections.map((section, i) => (
						<button
							key={section.title ?? i}
							type="button"
							role="tab"
							aria-selected={i === active}
							onClick={() => setActive(i)}
							className={cn(
								'px-3 py-2 text-sm font-medium -mb-px border-b-2',
								i === active
									? 'border-primary text-foreground'
									: 'border-transparent text-muted-foreground hover:text-foreground',
							)}
						>
							{section.title}
						</button>
					))}
				</div>
				<div role="tabpanel">
					{activeSection.description && (
						<p className="mb-3 text-sm text-muted-foreground">
							{activeSection.description}
						</p>
					)}
					{renderFields(activeSection)}
				</div>
				{footer}
			</div>
		)
	}

	if (variant === 'accordion') {
		return (
			<div className="space-y-3">
				{sections.map((section, i) => (
					<details
						key={section.title ?? i}
						open={i === 0}
						className="rounded-md border border-input"
					>
						<summary className="cursor-pointer px-3 py-2 text-sm font-medium">
							{section.title}
						</summary>
						<div className="border-t border-input p-3">
							{section.description && (
								<p className="mb-3 text-sm text-muted-foreground">
									{section.description}
								</p>
							)}
							{renderFields(section)}
						</div>
					</details>
				))}
				{footer}
			</div>
		)
	}

	// panels
	return (
		<div className="space-y-6">
			{sections.map((section, i) => (
				<fieldset
					key={section.title ?? i}
					className="space-y-3 rounded-md border border-input p-4"
				>
					{section.title && (
						<legend className="px-1 text-sm font-semibold">
							{section.title}
						</legend>
					)}
					{section.description && (
						<p className="text-sm text-muted-foreground">
							{section.description}
						</p>
					)}
					{renderFields(section)}
				</fieldset>
			))}
			{footer}
		</div>
	)
}

export function WizardBody({
	sections,
	step,
	setStep,
	onNext,
	renderFields,
	submitButtons,
}: BodyProps & {
	step: number
	setStep: (n: number) => void
	onNext: () => void
	submitButtons: React.ReactNode
}) {
	const lastStep = sections.length - 1
	const section = sections[step] ?? sections[0]
	if (!section) return null
	return (
		<div className="space-y-6">
			{/* Progress affordance. */}
			<ol className="flex items-center gap-2 text-sm" aria-label="Progress">
				{sections.map((s, i) => (
					<li
						key={s.title ?? i}
						aria-current={i === step ? 'step' : undefined}
						className={cn(
							'flex items-center gap-2',
							i === step
								? 'font-semibold text-foreground'
								: i < step
									? 'text-foreground'
									: 'text-muted-foreground',
						)}
					>
						<span
							className={cn(
								'flex size-6 items-center justify-center rounded-full border text-xs',
								i === step
									? 'border-primary bg-primary text-primary-foreground'
									: i < step
										? 'border-primary text-primary'
										: 'border-input',
							)}
						>
							{i < step ? '✓' : i + 1}
						</span>
						{s.title}
					</li>
				))}
			</ol>

			<p className="text-sm text-muted-foreground">
				Step {step + 1} of {sections.length}
			</p>

			{/* Every step stays mounted (hidden when inactive) so its values persist
			    across navigation and are present in the final submitted FormData —
			    only the active step is visible/focusable. */}
			{sections.map((s, i) => (
				<fieldset key={s.title ?? i} hidden={i !== step} className="space-y-3">
					{s.title && (
						<legend className="text-base font-semibold">{s.title}</legend>
					)}
					{s.description && (
						<p className="text-sm text-muted-foreground">{s.description}</p>
					)}
					{renderFields(s)}
				</fieldset>
			))}

			<div className="flex gap-2">
				<Button
					type="button"
					disabled={step === 0}
					onClick={() => setStep(Math.max(0, step - 1))}
					className="bg-secondary text-secondary-foreground hover:bg-secondary/80"
				>
					Back
				</Button>
				{step < lastStep ? (
					<Button type="button" onClick={onNext}>
						Next
					</Button>
				) : (
					submitButtons
				)}
			</div>
		</div>
	)
}
