import maxstack from 'maxstack'
import Template, { registry } from '~/components/templates/template'
import type { Route } from './+types/home'

export function meta({}: Route.MetaArgs) {
	return [
		{ title: maxstack.name },
		{ name: 'description', content: registry.landing.metaDescription },
	]
}

export default function Home({}: Route.ComponentProps) {
	return <Template componentName="maxstackWelcome" props={{}} />
}
